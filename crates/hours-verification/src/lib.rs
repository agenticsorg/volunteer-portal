//! Hours & Verification bounded context. See `.plans/ddd/hours-verification.md`.
//! Implemented in Prompts 4.1-4.2, 6.1.

mod assignment_snapshot;
mod error;
mod events;
mod hour_entry;
mod hours;
mod repository;

pub use assignment_snapshot::{
    AssignmentSnapshot, AssignmentSnapshotQuery, AssignmentStatus, ParticipationMode,
};
pub use error::HourEntryError;
pub use events::{HoursAdjusted, HoursApproved, HoursLogged, HoursRejected};
pub use hour_entry::{Adjustment, HourEntry, HourEntryStatus};
pub use hours::{DateRange, Hours};
pub use repository::{HourEntryRepository, HoursTotalsQuery, SqlxHourEntryRepository};
