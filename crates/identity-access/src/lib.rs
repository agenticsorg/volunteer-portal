//! Identity & Access bounded context. See `.plans/ddd/identity-access.md`.
//! Depends only on `kernel`, per context-map.md's dependency graph.

mod events;
mod oauth;
mod repository;
mod roster;
mod summary;
mod volunteer;

pub use events::{OAuthAccountLinked, RoleChanged, VolunteerAnonymized, VolunteerApproved, VolunteerOnboarded};
pub use oauth::{OAuthLink, OAuthProvider};
pub use repository::{SqlxVolunteerRepository, VolunteerRepository};
pub use roster::{SqlxVolunteerRosterQuery, VolunteerRosterFilter, VolunteerRosterQuery, VolunteerRosterRow};
pub use summary::{SqlxVolunteerSummaryQuery, VolunteerContact, VolunteerSummary, VolunteerSummaryQuery};
pub use volunteer::{Agreements, Availability, Role, Volunteer, VolunteerError, VolunteerStatus};
