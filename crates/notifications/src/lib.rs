//! Notifications bounded context. See `.plans/ddd/notifications.md`.
//! Implemented in Prompt 7.1. Depends on `kernel` and `identity-access`
//! only -- no compile-time dependency on `projects-assignments`,
//! `hours-verification`, or `discord-integration` (this context's
//! `AssignmentRecipientQuery`/`HourEntryRecipientQuery`/`DiscordDmSender`
//! ports are implemented by `apps/api` adapters instead, the same shape
//! `hours-verification`'s `AssignmentSnapshotQuery` established).

mod discord_dm;
mod dispatch;
mod email_provider;
mod events;
mod notification_attempt;
mod recipient;
mod repository;

pub use discord_dm::{DiscordDeliveryError, DiscordDmSender, DmContent};
pub use dispatch::{DispatchOutcome, NotificationDispatcher, NotificationError};
pub use email_provider::{EmailError, EmailProvider, EmailTemplate, ProviderMessageId, TemplateData};
pub use events::{NotificationFailed, NotificationSent};
pub use notification_attempt::{AttemptStatus, Channel, NotificationAttempt, TriggerType};
pub use recipient::{AssignmentRecipient, AssignmentRecipientQuery, HourEntryRecipient, HourEntryRecipientQuery};
pub use repository::{NotificationAttemptRepository, SqlxNotificationAttemptRepository};
