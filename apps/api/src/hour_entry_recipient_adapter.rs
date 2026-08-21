//! The concrete `notifications::HourEntryRecipientQuery` implementation,
//! same cross-sibling-crate adapter shape as
//! `assignment_recipient_adapter.rs`. Resolves `HoursApproved`'s outbox
//! payload (`hour_entry_id` only) into the actual recipient and the
//! approved hours/date the notification email reports.

use async_trait::async_trait;
use hours_verification::{HourEntryRepository, SqlxHourEntryRepository};
use kernel::RepoError;
use notifications::{HourEntryRecipient, HourEntryRecipientQuery};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub struct HoursVerificationRecipientAdapter;

#[async_trait]
impl HourEntryRecipientQuery for HoursVerificationRecipientAdapter {
    async fn recipient_for_hour_entry(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        hour_entry_id: Uuid,
    ) -> Result<Option<HourEntryRecipient>, RepoError> {
        let repo = SqlxHourEntryRepository;
        let Some(entry) = repo.find_by_id(tx, kernel::Id::from_uuid(hour_entry_id)).await? else {
            return Ok(None);
        };

        Ok(Some(HourEntryRecipient {
            volunteer_id: entry.volunteer_id(),
            hours: entry.hours().value(),
            date: entry.date(),
        }))
    }
}
