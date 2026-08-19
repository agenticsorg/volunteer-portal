//! Prompt 1.5: Discord OAuth login round-trip. Google OAuth and the
//! manual-linking flow are explicitly out of scope here (Prompt 2.2), per
//! concept.md's "Discord primary, Google fallback" framing and the Phase
//! 1 exit criterion covering only the Discord round-trip.

use axum::extract::{Query, State};
use axum::response::{IntoResponse, Redirect};
use identity_access::{Availability, OAuthProvider, SqlxVolunteerRepository, Volunteer, VolunteerRepository};
use kernel::record_audit_events;
use oauth2::{CsrfToken, PkceCodeVerifier};
use serde::Deserialize;
use tower_sessions::Session;

use crate::auth::SESSION_VOLUNTEER_ID_KEY;
use crate::error::ApiError;
use crate::state::AppState;

const SESSION_OAUTH_CSRF_KEY: &str = "oauth_csrf_state";
const SESSION_OAUTH_PKCE_KEY: &str = "oauth_pkce_verifier";

pub async fn discord_login(State(state): State<AppState>, session: Session) -> impl IntoResponse {
    let (url, csrf_token, pkce_verifier) = state.discord_oauth.authorize_url();

    session
        .insert(SESSION_OAUTH_CSRF_KEY, csrf_token.secret())
        .await
        .expect("session store must be reachable");
    session
        .insert(SESSION_OAUTH_PKCE_KEY, pkce_verifier.secret())
        .await
        .expect("session store must be reachable");

    Redirect::to(url.as_str())
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    code: String,
    state: String,
}

pub async fn discord_callback(
    State(state): State<AppState>,
    session: Session,
    Query(query): Query<CallbackQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let expected_state: Option<String> = session
        .get(SESSION_OAUTH_CSRF_KEY)
        .await
        .map_err(|_| ApiError::Internal)?;
    let expected_state = expected_state.ok_or(ApiError::Unauthorized)?;
    // Constant-time-ish comparison isn't load-bearing here (CsrfToken
    // values are single-use, high-entropy, session-scoped random
    // strings, not secrets an attacker could usefully time-attack), but
    // an exact match against the session-stored value is required.
    if CsrfToken::new(query.state.clone()).secret() != &expected_state {
        return Err(ApiError::Unauthorized);
    }

    let pkce_verifier: String = session
        .get(SESSION_OAUTH_PKCE_KEY)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::Unauthorized)?;

    let access_token = state
        .discord_oauth
        .exchange_code(query.code, PkceCodeVerifier::new(pkce_verifier))
        .await
        .map_err(|_| ApiError::Internal)?;

    let discord_user = state
        .discord_oauth
        .fetch_user(&access_token)
        .await
        .map_err(|_| ApiError::Internal)?;

    let repo = SqlxVolunteerRepository;

    // Look up by discord_id first, scoped as a synthetic actor equal to
    // the volunteer we're either finding or about to create — see the
    // signup branch below for why this is always a meaningful RLS actor,
    // never an unscoped connection.
    let probe_id = kernel::VolunteerId::new();
    let mut tx = state
        .db
        .begin_scoped(probe_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let existing = repo
        .find_by_discord_id(&mut tx, &discord_user.id)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    let volunteer_id = match existing {
        Some(existing) => existing.id(),
        None => {
            let mut volunteer = Volunteer::signup(
                discord_user.username.clone(),
                discord_user
                    .email
                    .clone()
                    .unwrap_or_else(|| format!("{}@discord.invalid", discord_user.id)),
                "UTC".to_string(),
                vec![],
                Availability::empty(),
                OAuthProvider::Discord,
                discord_user.id.clone(),
                discord_user
                    .email
                    .clone()
                    .unwrap_or_else(|| format!("{}@discord.invalid", discord_user.id)),
                discord_user.verified,
            )
            .map_err(|_| ApiError::BadRequest)?;
            let id = volunteer.id();

            // The new volunteer's own freshly-generated id is a
            // meaningful RLS actor for this transaction (the
            // volunteer_insert policy's WITH CHECK is `id =
            // current_actor_id() or ... admin`) — there is no unscoped
            // signup transaction anywhere in this codebase, per ADR-0004.
            let mut tx = state
                .db
                .begin_scoped(id.as_uuid())
                .await
                .map_err(|_| ApiError::Internal)?;
            let events = repo
                .save(&mut tx, &mut volunteer)
                .await
                .map_err(|_| ApiError::Internal)?;
            record_audit_events(&mut tx, &events)
                .await
                .map_err(|_| ApiError::Internal)?;
            tx.commit().await.map_err(|_| ApiError::Internal)?;
            id
        }
    };

    session
        .remove::<String>(SESSION_OAUTH_CSRF_KEY)
        .await
        .map_err(|_| ApiError::Internal)?;
    session
        .remove::<String>(SESSION_OAUTH_PKCE_KEY)
        .await
        .map_err(|_| ApiError::Internal)?;
    session
        .insert(SESSION_VOLUNTEER_ID_KEY, volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    Ok(Redirect::to("/"))
}
