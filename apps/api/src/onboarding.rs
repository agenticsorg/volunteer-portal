//! Prompt 2.3: the signup form (concept.md section 3) and admin
//! approval. OAuth login (Prompt 1.5/2.2) already creates a bare
//! `Volunteer` row with a provider-supplied name/email; this is the
//! follow-up step where the volunteer fills in the rest of their
//! profile and accepts all three agreements together, and the later,
//! separate admin action that actually approves them.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use identity_access::{Agreements, Availability, SqlxVolunteerRepository, VolunteerRepository};
use kernel::{record_audit_events, record_outbox_events, Id, Skill, VolunteerId};
use serde::Deserialize;
use ts_rs::TS;
use uuid::Uuid;

use crate::auth::{AdminUser, AuthUser};
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "CompleteOnboardingRequest.ts")]
pub struct CompleteOnboardingRequest {
    pub name: String,
    pub timezone: String,
    pub skills: Vec<String>,
    /// concept.md doesn't specify a shape beyond "availability" — kept
    /// as an opaque JSON value on the wire too, matching
    /// identity-access.md's `Availability` value object. ts-rs has no
    /// built-in mapping for `serde_json::Value`; `unknown` is the
    /// accurate TypeScript equivalent of "arbitrary JSON," not `any`.
    #[ts(type = "unknown")]
    pub availability: serde_json::Value,
    /// ADR-0014's Phase 2 addition.
    pub country_region: Option<String>,
    /// All three must be `true`, together, in the same submission —
    /// `Agreements`' own "written once, together" design (concept.md
    /// section 3's form captures them in one submission).
    pub code_of_conduct_accepted: bool,
    pub ip_agreement_accepted: bool,
    pub age_attestation_confirmed: bool,
}

/// AuthUser-gated: this completes the *caller's own* onboarding — there
/// is no path for one volunteer to complete another's profile.
pub async fn complete_onboarding(
    AuthUser(volunteer_id): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<CompleteOnboardingRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if !(payload.code_of_conduct_accepted
        && payload.ip_agreement_accepted
        && payload.age_attestation_confirmed)
    {
        // concept.md section 3: all three are mandatory, not optional --
        // a submission missing any one of them is simply invalid, not a
        // partial-acceptance state to persist.
        return Err(ApiError::BadRequest);
    }

    let repo = SqlxVolunteerRepository;
    let mut tx = state
        .db
        .begin_scoped(volunteer_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let mut volunteer = repo
        .find_by_id(&mut tx, volunteer_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    let skills: Vec<Skill> = payload
        .skills
        .into_iter()
        .filter_map(|s| Skill::new(s).ok())
        .collect();
    let now = Utc::now();

    volunteer.complete_onboarding(
        payload.name,
        payload.timezone,
        skills,
        Availability(payload.availability),
        payload.country_region,
        Agreements {
            code_of_conduct_accepted_at: Some(now),
            ip_agreement_accepted_at: Some(now),
            age_attestation_confirmed_at: Some(now),
        },
    );

    // Not an AuditableEvent: this is the volunteer completing their own
    // profile, not an admin action or hour adjustment (concept.md
    // section 9 scopes the audit log to those) -- record_agreements
    // isn't paired with a domain event in identity-access.md either.
    repo.save(&mut tx, &mut volunteer)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(StatusCode::NO_CONTENT)
}

/// AdminUser-gated: the separate, later admin action that actually
/// approves a volunteer (`Volunteer::approve` refuses unless
/// `Agreements::is_complete()`, i.e. `complete_onboarding` above must
/// have already run). Goes through `record_audit_events` like every
/// other mutation -- no handler here writes `audit_log` directly.
pub async fn approve_volunteer(
    AdminUser(admin_id): AdminUser,
    State(state): State<AppState>,
    Path(target_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let target_id: VolunteerId = Id::from_uuid(target_id);
    let repo = SqlxVolunteerRepository;
    let mut tx = state
        .db
        .begin_scoped(admin_id.as_uuid())
        .await
        .map_err(|_| ApiError::Internal)?;
    let mut volunteer = repo
        .find_by_id(&mut tx, target_id)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;

    volunteer.approve(admin_id).map_err(|_| ApiError::BadRequest)?;

    let events = repo
        .save(&mut tx, &mut volunteer)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_audit_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    record_outbox_events(&mut tx, &events)
        .await
        .map_err(|_| ApiError::Internal)?;
    tx.commit().await.map_err(|_| ApiError::Internal)?;

    Ok(StatusCode::NO_CONTENT)
}
