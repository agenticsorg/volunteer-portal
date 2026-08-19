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

use identity_access::VolunteerSummary;
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
