//! Shared account-linking policy logic (ADR-0007, Prompt 2.2), used by
//! both the Discord and Google OAuth callbacks so the rule is enforced
//! identically regardless of which provider a login/link attempt is on.

use identity_access::{
    Availability, OAuthProvider, SqlxVolunteerRepository, Volunteer, VolunteerRepository,
};
use kernel::{record_audit_events, VolunteerId};

use crate::error::ApiError;
use crate::state::AppState;

pub enum LoginResolution {
    LoggedIn(VolunteerId),
    /// ADR-0007's collision case: a different, already-verified identity
    /// owns this email. Nothing is created or linked — the caller maps
    /// this to a 409 with the provider name so the frontend can show the
    /// "sign in with X, then link this one" prompt.
    Collision { existing_provider: &'static str },
}

/// The **only** entry point by which a login attempt (either provider)
/// resolves to a volunteer. Never auto-links across providers by email —
/// this is the concrete enforcement of ADR-0007's decision.
pub async fn resolve_login(
    state: &AppState,
    provider: OAuthProvider,
    provider_user_id: &str,
    email: Option<&str>,
    email_verified: bool,
    display_name: &str,
) -> Result<LoginResolution, ApiError> {
    let repo = SqlxVolunteerRepository;

    // 1. Returning volunteer: already linked under this exact
    //    (provider, provider_user_id) pair. `find_by_oauth_identity` is
    //    backed by a SECURITY DEFINER function specifically so this
    //    pre-auth lookup works regardless of the probe transaction's
    //    (necessarily arbitrary) RLS actor — it returns only an id,
    //    never the full row, so no RLS-scoped read of someone else's
    //    data happens here.
    let probe = VolunteerId::new();
    let mut tx = state
        .db
        .begin_scoped(probe.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let existing_id = repo
        .find_by_oauth_identity(&mut tx, provider, provider_user_id)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    if let Some(id) = existing_id {
        return Ok(LoginResolution::LoggedIn(id));
    }

    // 2. ADR-0007's collision check: does a *different*, verified
    //    identity already own this email? `email_verified` on file for
    //    that existing identity is what's checked, per ADR-0007's
    //    explicit "an unverified email claimed by an OAuth provider is
    //    not proof of ownership" — never the new login attempt's own
    //    verification state. Same SECURITY DEFINER shape as step 1:
    //    only the id and provider of the colliding identity come back,
    //    not the full aggregate.
    if let Some(email) = email {
        let mut tx = state
            .db
            .begin_scoped(probe.as_uuid())
            .await
            .map_err(|_| ApiError::Internal)?;
        let collision = repo
            .find_by_verified_identity_email(&mut tx, email)
            .await
            .map_err(|_| ApiError::Internal)?;
        tx.commit().await.map_err(|_| ApiError::Internal)?;

        if let Some((_, existing_provider)) = collision {
            return Ok(LoginResolution::Collision {
                existing_provider: existing_provider.as_str(),
            });
        }
    }

    // 3. No existing identity, no collision: first-ever login.
    let mut volunteer = Volunteer::signup(
        display_name.to_string(),
        email
            .map(str::to_string)
            .unwrap_or_else(|| format!("{provider_user_id}@{}.invalid", provider.as_str())),
        "UTC".to_string(),
        vec![],
        Availability::empty(),
        provider,
        provider_user_id.to_string(),
        email
            .map(str::to_string)
            .unwrap_or_else(|| format!("{provider_user_id}@{}.invalid", provider.as_str())),
        email_verified,
    )
    .map_err(|_| ApiError::BadRequest)?;
    let id = volunteer.id();

    // The new volunteer's own freshly-generated id is a meaningful RLS
    // actor for this transaction — there is no unscoped signup
    // transaction anywhere in this codebase, per ADR-0004.
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

    Ok(LoginResolution::LoggedIn(id))
}

/// The **only** entry point by which a second provider is linked to an
/// existing volunteer. `confirming_volunteer_id` must come from the
/// caller's own already-established session — identity-access.md's
/// `link_additional_provider` itself re-verifies this (refuses unless
/// `confirming_session_volunteer_id` equals the target volunteer's own
/// id), so this function cannot be used to link onto an arbitrary
/// account even if a caller supplied the wrong id by mistake or by
/// attack.
pub async fn complete_link(
    state: &AppState,
    confirming_volunteer_id: VolunteerId,
    provider: OAuthProvider,
    provider_user_id: String,
    email: String,
    email_verified: bool,
) -> Result<(), ApiError> {
    let repo = SqlxVolunteerRepository;
    let mut tx = state
        .db
        .begin_scoped(confirming_volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let mut volunteer = repo
        .find_by_id(&mut tx, confirming_volunteer_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    volunteer
        .link_additional_provider(
            provider,
            provider_user_id,
            email,
            email_verified,
            confirming_volunteer_id,
        )
        .map_err(|_| ApiError::Forbidden)?;

    let events = repo
        .save(&mut tx, &mut volunteer)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(())
}
