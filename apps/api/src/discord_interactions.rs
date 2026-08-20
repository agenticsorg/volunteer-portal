//! Discord interaction webhook signature verification (Prompt 5.2,
//! ADR-0008): the request signature (`X-Signature-Ed25519`/
//! `X-Signature-Timestamp`) must be verified via `ed25519-dalek` BEFORE
//! any JSON payload parsing happens -- this is required regardless of
//! Discord crate choice, per Discord's documented interaction-security
//! requirement, and must be implemented once, correctly, and tested.
//!
//! Discord does not publish a fixed, downloadable set of signature test
//! vectors (unlike, say, an RFC's known-answer tests) -- their documented
//! contract is the *construction* (verify Ed25519 over `timestamp ||
//! body` using the interactions application's public key) rather than a
//! canned byte sequence. This module's tests instead construct a real
//! (deterministic-seed) Ed25519 keypair via `ed25519-dalek` itself, sign
//! a Discord-shaped message the same way Discord's servers do, and assert
//! both that a genuinely valid signature is accepted and that every
//! tampering vector (wrong body, wrong timestamp, wrong signature, wrong
//! key) is rejected -- the standard testing approach for a construction
//! whose correctness is defined by an algorithm, not a fixed corpus.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use discord_integration::{DiscordUserId, LinkCommandHandler, LinkStatus};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use identity_access::SqlxVolunteerRepository;
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureVerificationError {
    InvalidHexEncoding,
    InvalidPublicKey,
    InvalidSignatureEncoding,
    SignatureMismatch,
}

/// Verifies `X-Signature-Ed25519`/`X-Signature-Timestamp` against the
/// concatenated `timestamp || body` bytes, per Discord's documented
/// interaction-verification contract. The caller must call this and
/// confirm `Ok(())` **before** parsing `body` as JSON.
pub fn verify_discord_signature(
    public_key_hex: &str,
    signature_hex: &str,
    timestamp: &str,
    body: &[u8],
) -> Result<(), SignatureVerificationError> {
    let public_key_bytes =
        hex::decode(public_key_hex).map_err(|_| SignatureVerificationError::InvalidHexEncoding)?;
    let public_key_bytes: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| SignatureVerificationError::InvalidPublicKey)?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_bytes)
        .map_err(|_| SignatureVerificationError::InvalidPublicKey)?;

    let signature_bytes =
        hex::decode(signature_hex).map_err(|_| SignatureVerificationError::InvalidHexEncoding)?;
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| SignatureVerificationError::InvalidSignatureEncoding)?;

    let mut message = Vec::with_capacity(timestamp.len() + body.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(body);

    verifying_key
        .verify(&message, &signature)
        .map_err(|_| SignatureVerificationError::SignatureMismatch)
}

/// Discord's interaction payload shape, narrowed to only the fields
/// `/link` needs -- deliberately hand-rolled `serde` types rather than
/// `twilight_model`'s interaction types, since this endpoint lives in
/// `apps/api` (the composition root), not the `discord-integration`
/// domain crate the ACL boundary rule (discord-integration.md) actually
/// restricts.
#[derive(Debug, Deserialize)]
struct DiscordInteractionPayload {
    #[serde(rename = "type")]
    interaction_type: u8,
    data: Option<DiscordInteractionData>,
    member: Option<DiscordInteractionMember>,
    user: Option<DiscordInteractionUser>,
}

#[derive(Debug, Deserialize)]
struct DiscordInteractionData {
    name: String,
}

#[derive(Debug, Deserialize)]
struct DiscordInteractionMember {
    user: DiscordInteractionUser,
}

#[derive(Debug, Deserialize)]
struct DiscordInteractionUser {
    id: String,
}

impl DiscordInteractionPayload {
    /// Guild-context interactions carry the invoker under `member.user`;
    /// DM-context interactions carry it directly under `user`.
    fn invoking_discord_user_id(&self) -> Option<&str> {
        self.member
            .as_ref()
            .map(|m| m.user.id.as_str())
            .or_else(|| self.user.as_ref().map(|u| u.id.as_str()))
    }
}

const INTERACTION_TYPE_PING: u8 = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND: u8 = 2;
const INTERACTION_RESPONSE_PONG: u8 = 1;
const INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE: u8 = 4;
/// Discord's `EPHEMERAL` message flag -- the reply is visible only to
/// the invoking user.
const MESSAGE_FLAG_EPHEMERAL: u64 = 1 << 6;

/// POST /discord/interactions -- the one Axum endpoint receiving Discord
/// interaction webhooks (ADR-0008: REST/HTTP-interactions only, no
/// persistent Gateway bot process anywhere in this codebase). Verifies
/// the signature over the raw body **before** any JSON parsing, per
/// Discord's documented interaction-security requirement.
pub async fn handle_interaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    let signature = headers
        .get("x-signature-ed25519")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let timestamp = headers
        .get("x-signature-timestamp")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    verify_discord_signature(&state.discord_interactions_public_key, signature, timestamp, &body)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    let payload: DiscordInteractionPayload =
        serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?;

    match payload.interaction_type {
        INTERACTION_TYPE_PING => Ok(Json(json!({ "type": INTERACTION_RESPONSE_PONG })).into_response()),
        INTERACTION_TYPE_APPLICATION_COMMAND => handle_application_command(state, payload).await,
        _ => Ok(StatusCode::BAD_REQUEST.into_response()),
    }
}

async fn handle_application_command(
    state: AppState,
    payload: DiscordInteractionPayload,
) -> Result<Response, StatusCode> {
    let command_name = payload.data.as_ref().map(|d| d.name.as_str()).unwrap_or_default();
    if command_name != "link" {
        return Ok(ephemeral_reply("Unknown command."));
    }

    let Some(discord_user_id) = payload.invoking_discord_user_id() else {
        return Err(StatusCode::BAD_REQUEST);
    };

    let handler = LinkCommandHandler::new(SqlxVolunteerRepository);
    let mut tx = state
        .db
        .begin_system_scoped()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let status = handler
        .handle_link(&mut tx, &DiscordUserId(discord_user_id.to_string()))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let content = match status {
        LinkStatus::AlreadyLinked => {
            "This Discord account is already connected to your volunteer profile."
        }
        LinkStatus::NotLinked => {
            "Not linked yet. Log in to the volunteer portal with whichever account you already \
             use, then connect your Discord account from your account settings."
        }
    };

    Ok(ephemeral_reply(content))
}

fn ephemeral_reply(content: &str) -> Response {
    Json(json!({
        "type": INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
        "data": { "content": content, "flags": MESSAGE_FLAG_EPHEMERAL },
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sign(signing_key: &SigningKey, timestamp: &str, body: &[u8]) -> String {
        let mut message = Vec::with_capacity(timestamp.len() + body.len());
        message.extend_from_slice(timestamp.as_bytes());
        message.extend_from_slice(body);
        hex::encode(signing_key.sign(&message).to_bytes())
    }

    /// Deterministic test keypairs -- no OS RNG dependency needed for a
    /// key that only ever needs to be internally consistent within the
    /// test itself, not cryptographically fresh.
    fn test_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    #[test]
    fn accepts_a_genuinely_valid_signature() {
        let signing_key = test_key(1);
        let public_key_hex = hex::encode(signing_key.verifying_key().to_bytes());
        let timestamp = "1700000000";
        let body = br#"{"type":1}"#;
        let signature_hex = sign(&signing_key, timestamp, body);

        assert_eq!(
            verify_discord_signature(&public_key_hex, &signature_hex, timestamp, body),
            Ok(())
        );
    }

    #[test]
    fn rejects_a_tampered_body() {
        let signing_key = test_key(1);
        let public_key_hex = hex::encode(signing_key.verifying_key().to_bytes());
        let timestamp = "1700000000";
        let signature_hex = sign(&signing_key, timestamp, br#"{"type":1}"#);

        let tampered_body = br#"{"type":2}"#;
        assert_eq!(
            verify_discord_signature(&public_key_hex, &signature_hex, timestamp, tampered_body),
            Err(SignatureVerificationError::SignatureMismatch)
        );
    }

    #[test]
    fn rejects_a_tampered_timestamp() {
        let signing_key = test_key(1);
        let public_key_hex = hex::encode(signing_key.verifying_key().to_bytes());
        let body = br#"{"type":1}"#;
        let signature_hex = sign(&signing_key, "1700000000", body);

        assert_eq!(
            verify_discord_signature(&public_key_hex, &signature_hex, "1700000001", body),
            Err(SignatureVerificationError::SignatureMismatch)
        );
    }

    #[test]
    fn rejects_a_signature_from_the_wrong_key() {
        let signing_key = test_key(1);
        let wrong_key = test_key(2);
        let public_key_hex = hex::encode(wrong_key.verifying_key().to_bytes());
        let timestamp = "1700000000";
        let body = br#"{"type":1}"#;
        let signature_hex = sign(&signing_key, timestamp, body);

        assert_eq!(
            verify_discord_signature(&public_key_hex, &signature_hex, timestamp, body),
            Err(SignatureVerificationError::SignatureMismatch)
        );
    }

    #[test]
    fn rejects_malformed_hex_in_either_field() {
        let signing_key = test_key(1);
        let public_key_hex = hex::encode(signing_key.verifying_key().to_bytes());

        assert_eq!(
            verify_discord_signature(&public_key_hex, "not-hex", "1700000000", b"{}"),
            Err(SignatureVerificationError::InvalidHexEncoding)
        );
        assert_eq!(
            verify_discord_signature("not-hex", "aa", "1700000000", b"{}"),
            Err(SignatureVerificationError::InvalidHexEncoding)
        );
    }

    #[test]
    fn rejects_a_public_key_of_the_wrong_length() {
        assert_eq!(
            verify_discord_signature("aabb", "aa", "1700000000", b"{}"),
            Err(SignatureVerificationError::InvalidPublicKey)
        );
    }
}
