//! Identity & Access bounded context. See `.plans/ddd/identity-access.md`.
//! Depends only on `kernel`, per context-map.md's dependency graph.

mod events;
mod oauth;
mod repository;
mod summary;
mod volunteer;

pub use events::{OAuthAccountLinked, RoleChanged, VolunteerApproved, VolunteerOnboarded};
pub use oauth::{OAuthLink, OAuthProvider};
pub use repository::{SqlxVolunteerRepository, VolunteerRepository};
pub use summary::{SqlxVolunteerSummaryQuery, VolunteerContact, VolunteerSummary, VolunteerSummaryQuery};
pub use volunteer::{Agreements, Availability, Role, Volunteer, VolunteerError, VolunteerStatus};
