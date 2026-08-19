//! HTTP-facing request/response types (ADR-0011's "generated TypeScript
//! types from Rust request/response types"). Deliberately separate from
//! the domain types in `identity-access` etc. — the domain layer doesn't
//! need to know about the wire format, and the wire format shouldn't leak
//! aggregate internals (`identity-access.md`'s `VolunteerSummary` is
//! already the narrow cross-context read type; this is one narrower
//! still, HTTP-serialization-shaped).
//!
//! Run `cargo test -p api` to (re)generate the `.ts` bindings into
//! `apps/web/src/generated/` — wired into the frontend build via Prompt
//! 2.1's `predev`/`prebuild` npm scripts, so a Rust type change that
//! isn't reflected in frontend usage fails to type-check there.

use hours_verification::HourEntry;
use identity_access::VolunteerSummary;
use projects_assignments::{Assignment, ProjectSummary};
use serde::Serialize;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "CurrentUser.ts")]
pub struct CurrentUser {
    pub id: Uuid,
    pub name: String,
    pub role: String,
    pub status: String,
}

impl From<VolunteerSummary> for CurrentUser {
    fn from(s: VolunteerSummary) -> Self {
        Self {
            id: s.id.as_uuid(),
            name: s.name,
            role: s.role.as_str().to_string(),
            status: s.status.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "ProjectSummary.ts")]
pub struct ProjectSummaryDto {
    pub id: Uuid,
    pub name: String,
    pub project_type: String,
    pub status: String,
}

impl From<ProjectSummary> for ProjectSummaryDto {
    fn from(s: ProjectSummary) -> Self {
        Self {
            id: s.id.as_uuid(),
            name: s.name,
            project_type: s.project_type.as_str().to_string(),
            status: s.status.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "Assignment.ts")]
pub struct AssignmentDto {
    pub id: Uuid,
    pub volunteer_id: Uuid,
    pub project_id: Uuid,
    pub role: String,
    pub participation_mode: String,
    pub status: String,
}

impl From<Assignment> for AssignmentDto {
    fn from(a: Assignment) -> Self {
        Self {
            id: a.id().as_uuid(),
            volunteer_id: a.volunteer_id().as_uuid(),
            project_id: a.project_id().as_uuid(),
            role: a.role().to_string(),
            participation_mode: a.participation_mode().as_str().to_string(),
            status: a.status().as_str().to_string(),
        }
    }
}

/// `hours` and `adjustment.previous_hours` cross the wire as decimal
/// strings (e.g. `"3.50"`), never as a JSON number -- ts-rs has no
/// `rust_decimal` support, and a `String` also avoids floating-point
/// round-tripping a value that feeds compliance-facing totals.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "Adjustment.ts")]
pub struct AdjustmentDto {
    pub adjusted_by: Uuid,
    pub previous_hours: String,
    pub reason: String,
    pub adjusted_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "HourEntry.ts")]
pub struct HourEntryDto {
    pub id: Uuid,
    pub volunteer_id: Uuid,
    pub assignment_id: Uuid,
    pub date: chrono::NaiveDate,
    pub hours: String,
    pub description: String,
    pub status: String,
    pub approver_id: Option<Uuid>,
    pub decided_at: Option<chrono::DateTime<chrono::Utc>>,
    pub adjustment: Option<AdjustmentDto>,
}

impl From<HourEntry> for HourEntryDto {
    fn from(e: HourEntry) -> Self {
        Self {
            id: e.id().as_uuid(),
            volunteer_id: e.volunteer_id().as_uuid(),
            assignment_id: e.assignment_id().as_uuid(),
            date: e.date(),
            hours: e.hours().value().to_string(),
            description: e.description().to_string(),
            status: e.status().as_str().to_string(),
            approver_id: e.approver_id().map(|id| id.as_uuid()),
            decided_at: e.decided_at(),
            adjustment: e.adjustment().map(|a| AdjustmentDto {
                adjusted_by: a.adjusted_by.as_uuid(),
                previous_hours: a.previous_hours.value().to_string(),
                reason: a.reason.clone(),
                adjusted_at: a.adjusted_at,
            }),
        }
    }
}
