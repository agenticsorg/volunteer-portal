use async_trait::async_trait;
use kernel::{DataSubjectRequestId, DomainEvent, Id, RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};

use crate::request::{DataSubjectRequest, RequestStatus, RequestType};

#[async_trait]
pub trait DataSubjectRequestRepository: Send + Sync {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: DataSubjectRequestId,
    ) -> Result<Option<DataSubjectRequest>, RepoError>;

    async fn find_by_volunteer(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
    ) -> Result<Vec<DataSubjectRequest>, RepoError>;

    /// The admin queue: every `Received` or `InProgress` request, oldest
    /// first -- mirrors `HourEntryRepository::find_pending_for_lead`'s
    /// shape in hours-verification.md.
    async fn find_pending(&self, tx: &mut Transaction<'_, Postgres>) -> Result<Vec<DataSubjectRequest>, RepoError>;

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        request: &mut DataSubjectRequest,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}

pub struct SqlxDataSubjectRequestRepository;

struct Row {
    id: uuid::Uuid,
    volunteer_id: uuid::Uuid,
    request_type: String,
    status: String,
    requested_at: chrono::DateTime<chrono::Utc>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
    handled_by: Option<uuid::Uuid>,
    rejection_reason: Option<String>,
}

fn row_to_request(row: Row) -> DataSubjectRequest {
    DataSubjectRequest::from_persisted(
        Id::from_uuid(row.id),
        Id::from_uuid(row.volunteer_id),
        RequestType::parse(&row.request_type).expect("request_type column must be valid"),
        RequestStatus::parse(&row.status).expect("status column must be valid"),
        row.requested_at,
        row.completed_at,
        row.handled_by.map(Id::from_uuid),
        row.rejection_reason,
    )
}

#[async_trait]
impl DataSubjectRequestRepository for SqlxDataSubjectRequestRepository {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: DataSubjectRequestId,
    ) -> Result<Option<DataSubjectRequest>, RepoError> {
        let row = sqlx::query_as!(
            Row,
            r#"select id, volunteer_id, request_type, status,
                      requested_at as "requested_at: chrono::DateTime<chrono::Utc>",
                      completed_at as "completed_at: chrono::DateTime<chrono::Utc>",
                      handled_by, rejection_reason
               from data_subject_request where id = $1"#,
            id.as_uuid()
        )
        .fetch_optional(&mut **tx)
        .await?;

        Ok(row.map(row_to_request))
    }

    async fn find_by_volunteer(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
    ) -> Result<Vec<DataSubjectRequest>, RepoError> {
        let rows = sqlx::query_as!(
            Row,
            r#"select id, volunteer_id, request_type, status,
                      requested_at as "requested_at: chrono::DateTime<chrono::Utc>",
                      completed_at as "completed_at: chrono::DateTime<chrono::Utc>",
                      handled_by, rejection_reason
               from data_subject_request where volunteer_id = $1
               order by requested_at asc"#,
            volunteer_id.as_uuid()
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows.into_iter().map(row_to_request).collect())
    }

    async fn find_pending(&self, tx: &mut Transaction<'_, Postgres>) -> Result<Vec<DataSubjectRequest>, RepoError> {
        let rows = sqlx::query_as!(
            Row,
            r#"select id, volunteer_id, request_type, status,
                      requested_at as "requested_at: chrono::DateTime<chrono::Utc>",
                      completed_at as "completed_at: chrono::DateTime<chrono::Utc>",
                      handled_by, rejection_reason
               from data_subject_request
               where status in ('received', 'in_progress')
               order by requested_at asc"#,
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows.into_iter().map(row_to_request).collect())
    }

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        request: &mut DataSubjectRequest,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError> {
        sqlx::query!(
            r#"insert into data_subject_request (
                   id, volunteer_id, request_type, status, requested_at,
                   completed_at, handled_by, rejection_reason
               )
               values ($1, $2, $3, $4, $5, $6, $7, $8)
               on conflict (id) do update set
                   status = excluded.status,
                   completed_at = excluded.completed_at,
                   handled_by = excluded.handled_by,
                   rejection_reason = excluded.rejection_reason"#,
            request.id().as_uuid(),
            request.volunteer_id().as_uuid(),
            request.request_type().as_str(),
            request.status().as_str(),
            request.requested_at(),
            request.completed_at(),
            request.handled_by().map(|id| id.as_uuid()),
            request.rejection_reason(),
        )
        .execute(&mut **tx)
        .await?;

        Ok(request.take_events())
    }
}
