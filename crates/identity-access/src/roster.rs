//! Prompt 8.1: the admin roster view (concept.md section 8: "Roster
//! with filters and CSV export"). A read port over `volunteer`,
//! deliberately separate from `VolunteerSummaryQuery` (that trait's
//! methods are narrow, single-purpose cross-context reads; this one is
//! admin-only, filterable, and exposes more fields than any other
//! consumer needs).

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use kernel::{RepoError, VolunteerId};
use sqlx::{Postgres, Transaction};

use crate::volunteer::{Role, VolunteerStatus};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VolunteerRosterFilter {
    pub status: Option<VolunteerStatus>,
    pub role: Option<Role>,
    /// Matches a volunteer whose `skills` array contains this exact
    /// skill string (case-sensitive, matching how `Skill::new` already
    /// normalizes on input elsewhere in this codebase).
    pub skill: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolunteerRosterRow {
    pub id: VolunteerId,
    pub name: String,
    pub email: String,
    pub role: Role,
    pub status: VolunteerStatus,
    pub skills: Vec<String>,
    pub timezone: String,
    /// ADR-0014's self-reported field, surfaced here (rather than only
    /// on the `Volunteer` aggregate) so the admin roster is the "actually
    /// monitorable" source that ADR's GDPR Art. 27 trigger requires.
    pub country_region: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[async_trait]
pub trait VolunteerRosterQuery: Send + Sync {
    /// `limit: None` returns every matching row, unpaginated -- the CSV
    /// export path's shape (concept.md's "CSV export" is a bulk
    /// download, not a paginated view). `limit: Some(n)` backs the
    /// paginated admin UI list instead.
    async fn roster(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        filter: &VolunteerRosterFilter,
        limit: Option<i64>,
        offset: i64,
    ) -> Result<Vec<VolunteerRosterRow>, RepoError>;

    /// Total matching row count for the same filter, ignoring
    /// `limit`/`offset` -- pagination metadata for the admin UI list.
    async fn roster_count(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        filter: &VolunteerRosterFilter,
    ) -> Result<i64, RepoError>;

    /// ADR-0014's Phase 10 monitoring query: counts approved volunteers
    /// whose self-reported `country_region` matches one of the EU's 27
    /// member states (by name, case-insensitively -- the field is free
    /// text, not a controlled country-code column). Crossing 10 is the
    /// ADR's trigger to revisit the "no standing EU representative"
    /// decision. Only `Approved` volunteers count -- a `PendingApproval`
    /// signup hasn't yet become an active processing relationship, and
    /// an anonymized (`Suspended`, `country_region: None`) volunteer no
    /// longer has a country to count.
    async fn eu_volunteer_count(&self, tx: &mut Transaction<'_, Postgres>) -> Result<i64, RepoError>;
}

/// The EU's 27 member states, by the name a volunteer would plausibly
/// self-report in a free-text field. Not a controlled ISO-3166 code list
/// (the schema stores free text, matching concept.md's signup form) --
/// this is a best-effort monitoring aid for ADR-0014's trigger, not a
/// legal determination. Kept as a `const` here (identity-access owns the
/// `volunteer` table's columns) rather than duplicated at the API layer.
const EU_MEMBER_STATES: &[&str] = &[
    "austria",
    "belgium",
    "bulgaria",
    "croatia",
    "cyprus",
    "czechia",
    "czech republic",
    "denmark",
    "estonia",
    "finland",
    "france",
    "germany",
    "greece",
    "hungary",
    "ireland",
    "italy",
    "latvia",
    "lithuania",
    "luxembourg",
    "malta",
    "netherlands",
    "poland",
    "portugal",
    "romania",
    "slovakia",
    "slovenia",
    "spain",
    "sweden",
];

pub struct SqlxVolunteerRosterQuery;

#[async_trait]
impl VolunteerRosterQuery for SqlxVolunteerRosterQuery {
    async fn roster(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        filter: &VolunteerRosterFilter,
        limit: Option<i64>,
        offset: i64,
    ) -> Result<Vec<VolunteerRosterRow>, RepoError> {
        let rows = sqlx::query!(
            r#"select id, name, email, role, status, skills, timezone, country_region,
                      created_at as "created_at: DateTime<Utc>"
               from volunteer
               where ($1::text is null or status = $1)
                 and ($2::text is null or role = $2)
                 and ($3::text is null or $3 = any(skills))
               order by created_at asc
               limit $4 offset $5"#,
            filter.status.map(|s| s.as_str()),
            filter.role.map(|r| r.as_str()),
            filter.skill.as_deref(),
            limit,
            offset,
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| VolunteerRosterRow {
                id: kernel::Id::from_uuid(r.id),
                name: r.name,
                email: r.email,
                role: Role::parse(&r.role).expect("role column must be a valid Role"),
                status: VolunteerStatus::parse(&r.status).expect("status column must be a valid VolunteerStatus"),
                skills: r.skills,
                timezone: r.timezone,
                country_region: r.country_region,
                created_at: r.created_at,
            })
            .collect())
    }

    async fn roster_count(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        filter: &VolunteerRosterFilter,
    ) -> Result<i64, RepoError> {
        let count: i64 = sqlx::query_scalar!(
            r#"select count(*) as "count!" from volunteer
               where ($1::text is null or status = $1)
                 and ($2::text is null or role = $2)
                 and ($3::text is null or $3 = any(skills))"#,
            filter.status.map(|s| s.as_str()),
            filter.role.map(|r| r.as_str()),
            filter.skill.as_deref(),
        )
        .fetch_one(&mut **tx)
        .await?;
        Ok(count)
    }

    async fn eu_volunteer_count(&self, tx: &mut Transaction<'_, Postgres>) -> Result<i64, RepoError> {
        let eu_member_states: Vec<String> = EU_MEMBER_STATES.iter().map(|s| s.to_string()).collect();
        let count: i64 = sqlx::query_scalar!(
            r#"select count(*) as "count!" from volunteer
               where status = 'approved' and lower(country_region) = any($1)"#,
            &eu_member_states,
        )
        .fetch_one(&mut **tx)
        .await?;
        Ok(count)
    }
}
