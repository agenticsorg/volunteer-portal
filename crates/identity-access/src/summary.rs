use async_trait::async_trait;
use kernel::{RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};

use crate::volunteer::{Role, VolunteerStatus};

/// The *only* thing exposed as a stable cross-context port beyond the bare
/// `VolunteerId`/`Role` types, per identity-access.md — full `Volunteer`
/// aggregates never cross a crate boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolunteerSummary {
    pub id: VolunteerId,
    pub name: String,
    pub role: Role,
    pub status: VolunteerStatus,
}

#[async_trait]
pub trait VolunteerSummaryQuery: Send + Sync {
    async fn summary(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: VolunteerId,
    ) -> Result<Option<VolunteerSummary>, RepoError>;

    /// Backs Discord Integration's "who should have the base role"
    /// reconcile query (Phase 5).
    async fn approved_summaries(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<VolunteerSummary>, RepoError>;
}

pub struct SqlxVolunteerSummaryQuery;

#[async_trait]
impl VolunteerSummaryQuery for SqlxVolunteerSummaryQuery {
    async fn summary(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: VolunteerId,
    ) -> Result<Option<VolunteerSummary>, RepoError> {
        let row = sqlx::query!(
            r#"select id, name, role, status from volunteer where id = $1"#,
            id.as_uuid()
        )
        .fetch_optional(&mut **tx)
        .await?;

        Ok(row.map(|r| VolunteerSummary {
            id: kernel::Id::from_uuid(r.id),
            name: r.name,
            role: Role::parse(&r.role).expect("role column must be a valid Role"),
            status: VolunteerStatus::parse(&r.status).expect("status column must be a valid VolunteerStatus"),
        }))
    }

    async fn approved_summaries(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<VolunteerSummary>, RepoError> {
        let rows = sqlx::query!(
            r#"select id, name, role, status from volunteer where status = 'approved'"#
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| VolunteerSummary {
                id: kernel::Id::from_uuid(r.id),
                name: r.name,
                role: Role::parse(&r.role).expect("role column must be a valid Role"),
                status: VolunteerStatus::parse(&r.status).expect("status column must be a valid VolunteerStatus"),
            })
            .collect())
    }
}
