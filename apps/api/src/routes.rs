//! Prompt 1.5 (Discord login round-trip) + Prompt 2.2 (Google OAuth and
//! the manual account-linking flow, per ADR-0007). Both providers share
//! the same account-linking policy logic (`crate::account_linking`), and
//! both support two intents, tracked in the session across the redirect
//! round-trip:
//! - **login** (`/auth/{provider}/login`): unauthenticated, resolves to
//!   an existing or newly-created volunteer, or an ADR-0007 collision.
//! - **link** (`/auth/{provider}/link`): requires an existing session
//!   (`AuthUser`), attaches a second provider identity to that same
//!   volunteer — this is the *only* path `Volunteer::link_additional_provider`
//!   is ever called from.

use axum::extract::{Query, State};
use axum::response::{IntoResponse, Redirect};
use axum::Json;
use identity_access::{OAuthProvider, SqlxVolunteerSummaryQuery, VolunteerSummaryQuery};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
use serde::Deserialize;
use tower_sessions::Session;

use crate::account_linking::{self, LoginResolution};
use crate::auth::{AuthUser, SESSION_VOLUNTEER_ID_KEY};
use crate::dto::CurrentUser;
use crate::error::ApiError;
use crate::state::AppState;

const SESSION_OAUTH_CSRF_KEY: &str = "oauth_csrf_state";
const SESSION_OAUTH_PKCE_KEY: &str = "oauth_pkce_verifier";
const SESSION_OAUTH_NONCE_KEY: &str = "oauth_nonce";
const SESSION_OAUTH_INTENT_KEY: &str = "oauth_flow_intent";

const INTENT_LOGIN: &str = "login";
const INTENT_LINK: &str = "link";

/// The natural "session/auth" wire type ADR-0011's ts-rs pipeline needs
/// an initial real example of — lets the frontend know who's logged in
/// without exposing the full `Volunteer` aggregate.
pub async fn me(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
) -> Result<Json<CurrentUser>, ApiError> {
    let query = SqlxVolunteerSummaryQuery;
    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let summary = query
        .summary(&mut tx, volunteer_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(Json(summary.into()))
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    code: String,
    state: String,
}

// --- Discord ---------------------------------------------------------

pub async fn discord_login(State(state): State<AppState>, session: Session) -> impl IntoResponse {
    start_discord_flow(state, session, INTENT_LOGIN).await
}

/// Requires an existing session: the caller is already signed in (via
/// Google) and is explicitly attaching Discord as a second provider.
pub async fn discord_link(
    AuthUser(_): AuthUser,
    State(state): State<AppState>,
    session: Session,
) -> impl IntoResponse {
    start_discord_flow(state, session, INTENT_LINK).await
}

async fn start_discord_flow(state: AppState, session: Session, intent: &'static str) -> impl IntoResponse {
    let (url, csrf_token, pkce_verifier) = state.discord_oauth.authorize_url();

    session
        .insert(SESSION_OAUTH_CSRF_KEY, csrf_token.secret())
        .await
        .expect("session store must be reachable");
    session
        .insert(SESSION_OAUTH_PKCE_KEY, pkce_verifier.secret())
        .await
        .expect("session store must be reachable");
    session
        .insert(SESSION_OAUTH_INTENT_KEY, intent)
        .await
        .expect("session store must be reachable");

    Redirect::to(url.as_str())
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

    let intent: String = session
        .get(SESSION_OAUTH_INTENT_KEY)
        .await
        .map_err(|_| ApiError::Internal)?
        .unwrap_or_else(|| INTENT_LOGIN.to_string());

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

    let outcome = if intent == INTENT_LINK {
        let confirming_id: uuid::Uuid = session
            .get(SESSION_VOLUNTEER_ID_KEY)
            .await
            .map_err(|_| ApiError::Internal)?
            .ok_or(ApiError::Unauthorized)?;
        let confirming_id: kernel::VolunteerId = kernel::Id::from_uuid(confirming_id);
        account_linking::complete_link(
            &state,
            confirming_id,
            OAuthProvider::Discord,
            discord_user.id.clone(),
            discord_user
                .email
                .clone()
                .unwrap_or_else(|| format!("{}@discord.invalid", discord_user.id)),
            discord_user.verified,
        )
        .await?;
        confirming_id
    } else {
        match account_linking::resolve_login(
            &state,
            OAuthProvider::Discord,
            &discord_user.id,
            discord_user.email.as_deref(),
            discord_user.verified,
            &discord_user.username,
        )
        .await?
        {
            LoginResolution::LoggedIn(id) => id,
            LoginResolution::Collision { existing_provider } => {
                return Err(ApiError::AccountExistsUnderOtherProvider {
                    provider: existing_provider,
                });
            }
        }
    };

    clear_oauth_flow_session(&session).await?;
    session
        .insert(SESSION_VOLUNTEER_ID_KEY, outcome.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    Ok(Redirect::to("/"))
}

// --- Google ------------------------------------------------------------

pub async fn google_login(State(state): State<AppState>, session: Session) -> Result<impl IntoResponse, ApiError> {
    start_google_flow(state, session, INTENT_LOGIN).await
}

pub async fn google_link(
    AuthUser(_): AuthUser,
    State(state): State<AppState>,
    session: Session,
) -> Result<impl IntoResponse, ApiError> {
    start_google_flow(state, session, INTENT_LINK).await
}

async fn start_google_flow(
    state: AppState,
    session: Session,
    intent: &'static str,
) -> Result<impl IntoResponse, ApiError> {
    let Some(google_oauth) = state.google_oauth.as_ref() else {
        return Err(ApiError::NotFound);
    };
    let (url, csrf_token, nonce) = google_oauth.authorize_url();

    session
        .insert(SESSION_OAUTH_CSRF_KEY, csrf_token.secret())
        .await
        .map_err(|_| ApiError::Internal)?;
    session
        .insert(SESSION_OAUTH_NONCE_KEY, nonce.secret())
        .await
        .map_err(|_| ApiError::Internal)?;
    session
        .insert(SESSION_OAUTH_INTENT_KEY, intent)
        .await
        .map_err(|_| ApiError::Internal)?;

    Ok(Redirect::to(url.as_str()))
}

pub async fn google_callback(
    State(state): State<AppState>,
    session: Session,
    Query(query): Query<CallbackQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let Some(google_oauth) = state.google_oauth.as_ref() else {
        return Err(ApiError::NotFound);
    };

    let expected_state: Option<String> = session
        .get(SESSION_OAUTH_CSRF_KEY)
        .await
        .map_err(|_| ApiError::Internal)?;
    let expected_state = expected_state.ok_or(ApiError::Unauthorized)?;
    if CsrfToken::new(query.state.clone()).secret() != &expected_state {
        return Err(ApiError::Unauthorized);
    }

    let nonce: String = session
        .get(SESSION_OAUTH_NONCE_KEY)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::Unauthorized)?;

    let intent: String = session
        .get(SESSION_OAUTH_INTENT_KEY)
        .await
        .map_err(|_| ApiError::Internal)?
        .unwrap_or_else(|| INTENT_LOGIN.to_string());

    let google_user = google_oauth
        .exchange_code(query.code, Nonce::new(nonce))
        .await
        .map_err(|_| ApiError::Internal)?;

    let outcome = if intent == INTENT_LINK {
        let confirming_id: uuid::Uuid = session
            .get(SESSION_VOLUNTEER_ID_KEY)
            .await
            .map_err(|_| ApiError::Internal)?
            .ok_or(ApiError::Unauthorized)?;
        let confirming_id: kernel::VolunteerId = kernel::Id::from_uuid(confirming_id);
        account_linking::complete_link(
            &state,
            confirming_id,
            OAuthProvider::Google,
            google_user.subject.clone(),
            google_user
                .email
                .clone()
                .unwrap_or_else(|| format!("{}@google.invalid", google_user.subject)),
            google_user.email_verified,
        )
        .await?;
        confirming_id
    } else {
        match account_linking::resolve_login(
            &state,
            OAuthProvider::Google,
            &google_user.subject,
            google_user.email.as_deref(),
            google_user.email_verified,
            google_user.name.as_deref().unwrap_or("Google volunteer"),
        )
        .await?
        {
            LoginResolution::LoggedIn(id) => id,
            LoginResolution::Collision { existing_provider } => {
                return Err(ApiError::AccountExistsUnderOtherProvider {
                    provider: existing_provider,
                });
            }
        }
    };

    clear_oauth_flow_session(&session).await?;
    session
        .insert(SESSION_VOLUNTEER_ID_KEY, outcome.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;

    Ok(Redirect::to("/"))
}

async fn clear_oauth_flow_session(session: &Session) -> Result<(), ApiError> {
    session
        .remove::<String>(SESSION_OAUTH_CSRF_KEY)
        .await
        .map_err(|_| ApiError::Internal)?;
    session
        .remove::<String>(SESSION_OAUTH_PKCE_KEY)
        .await
        .map_err(|_| ApiError::Internal)?;
    session
        .remove::<String>(SESSION_OAUTH_NONCE_KEY)
        .await
        .map_err(|_| ApiError::Internal)?;
    session
        .remove::<String>(SESSION_OAUTH_INTENT_KEY)
        .await
        .map_err(|_| ApiError::Internal)?;
    Ok(())
}
