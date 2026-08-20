use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use kernel::{AssignmentId, DomainEvent, Id, ProjectId, RepoError, Skill, VolunteerId};
use sqlx::{Postgres, Transaction};

use crate::assignment::{Assignment, AssignmentStatus, ParticipationMode};
use crate::project::{EventSchedule, LeadRole, Project, ProjectLead, ProjectStatus, ProjectType};

/// Read model for directory browsing / roster listing -- deliberately
/// narrower than the full `Project` aggregate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSummary {
    pub id: ProjectId,
    pub name: String,
    pub project_type: ProjectType,
    pub status: ProjectStatus,
}

#[async_trait]
pub trait ProjectRepository: Send + Sync {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: ProjectId,
    ) -> Result<Option<Project>, RepoError>;

    /// Backs the project directory, filterable by skill (concept.md
    /// section 4).
    async fn find_open_by_skill(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        skill: &Skill,
    ) -> Result<Vec<ProjectSummary>, RepoError>;

    /// Backs the `LeadOf` extractor's real implementation (ADR-0002),
    /// wired in this prompt to replace Prompt 1.4's stub.
    async fn find_led_by(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
    ) -> Result<Vec<ProjectSummary>, RepoError>;

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project: &mut Project,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}

/// Consumed by `hours-verification`'s command handlers and by the
/// `apps/api` `LeadOf` extractor -- one implementation
/// (`SqlxProjectRepository`, below), two consumers, per context-map.md's
/// direct-call mechanism.
#[async_trait]
pub trait LeadMembershipQuery: Send + Sync {
    async fn is_lead_of_project(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
        project_id: ProjectId,
    ) -> Result<bool, RepoError>;
}

/// Backs Notifications' "meeting reminder" trigger (Phase 7) -- built
/// now, per Prompt 3.1's instruction, while already implementing
/// `Project`'s event-schedule fields.
pub struct EventOccurrence {
    pub project_id: ProjectId,
    pub project_name: String,
    pub next_occurrence_at: DateTime<Utc>,
    pub attendee_ids: Vec<VolunteerId>,
}

#[async_trait]
pub trait UpcomingEventOccurrencesQuery: Send + Sync {
    async fn find_occurring_within(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        window: Duration,
    ) -> Result<Vec<EventOccurrence>, RepoError>;
}

pub struct SqlxProjectRepository;

async fn load_leads(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<Vec<ProjectLead>, RepoError> {
    let rows = sqlx::query!(
        r#"select volunteer_id, role, assigned_at as "assigned_at: chrono::DateTime<chrono::Utc>"
           from project_lead where project_id = $1"#,
        project_id.as_uuid()
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ProjectLead {
            volunteer_id: Id::from_uuid(r.volunteer_id),
            role: LeadRole::parse(&r.role),
            assigned_at: r.assigned_at,
        })
        .collect())
}

#[async_trait]
impl ProjectRepository for SqlxProjectRepository {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: ProjectId,
    ) -> Result<Option<Project>, RepoError> {
        let row = sqlx::query!(
            r#"select id, name, description, type, needed_skills, status,
                      next_occurrence_at as "next_occurrence_at: chrono::DateTime<chrono::Utc>",
                      recurrence_note,
                      created_at as "created_at: chrono::DateTime<chrono::Utc>"
               from project where id = $1"#,
            id.as_uuid()
        )
        .fetch_optional(&mut **tx)
        .await?;

        let Some(row) = row else { return Ok(None) };
        let leads = load_leads(tx, id).await?;

        let project_type =
            ProjectType::parse(&row.r#type).expect("type column must be a valid ProjectType");
        let schedule = row.next_occurrence_at.map(|next_occurrence_at| EventSchedule {
            next_occurrence_at,
            recurrence_note: row.recurrence_note,
        });

        Ok(Some(Project::from_persisted(
            Id::from_uuid(row.id),
            row.name,
            row.description,
            project_type,
            row.needed_skills
                .into_iter()
                .filter_map(|s| Skill::new(s).ok())
                .collect(),
            ProjectStatus::parse(&row.status).expect("status column must be a valid ProjectStatus"),
            leads,
            schedule,
            row.created_at,
        )))
    }

    async fn find_open_by_skill(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        skill: &Skill,
    ) -> Result<Vec<ProjectSummary>, RepoError> {
        let rows = sqlx::query!(
            r#"select id, name, type, status from project
               where status = 'open' and $1 = any(needed_skills)"#,
            skill.as_str()
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| ProjectSummary {
                id: Id::from_uuid(r.id),
                name: r.name,
                project_type: ProjectType::parse(&r.r#type).expect("type column must be valid"),
                status: ProjectStatus::parse(&r.status).expect("status column must be valid"),
            })
            .collect())
    }

    async fn find_led_by(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
    ) -> Result<Vec<ProjectSummary>, RepoError> {
        let rows = sqlx::query!(
            r#"select p.id, p.name, p.type, p.status
               from project p
               join project_lead pl on pl.project_id = p.id
               where pl.volunteer_id = $1"#,
            volunteer_id.as_uuid()
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| ProjectSummary {
                id: Id::from_uuid(r.id),
                name: r.name,
                project_type: ProjectType::parse(&r.r#type).expect("type column must be valid"),
                status: ProjectStatus::parse(&r.status).expect("status column must be valid"),
            })
            .collect())
    }

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project: &mut Project,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError> {
        let needed_skills: Vec<String> = project
            .needed_skills()
            .iter()
            .map(|s| s.as_str().to_string())
            .collect();
        let (next_occurrence_at, recurrence_note) = match project.schedule() {
            Some(s) => (Some(s.next_occurrence_at), s.recurrence_note.clone()),
            None => (None, None),
        };

        sqlx::query!(
            r#"insert into project (id, name, description, type, needed_skills, status,
                                     next_occurrence_at, recurrence_note, created_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               on conflict (id) do update set
                   name = excluded.name,
                   description = excluded.description,
                   needed_skills = excluded.needed_skills,
                   status = excluded.status,
                   next_occurrence_at = excluded.next_occurrence_at,
                   recurrence_note = excluded.recurrence_note"#,
            project.id().as_uuid(),
            project.name(),
            project.description(),
            project.project_type().as_str(),
            &needed_skills,
            project.status().as_str(),
            next_occurrence_at,
            recurrence_note,
            project.created_at(),
        )
        .execute(&mut **tx)
        .await?;

        // project_lead reflects the aggregate's in-memory leads list
        // exactly: delete rows no longer present, upsert the rest. Small
        // collection (per projects-assignments.md), so a full
        // delete-and-reinsert-missing pass per save is fine.
        let current_lead_ids: Vec<uuid::Uuid> =
            project.leads().iter().map(|l| l.volunteer_id.as_uuid()).collect();
        sqlx::query!(
            "delete from project_lead where project_id = $1 and volunteer_id != all($2)",
            project.id().as_uuid(),
            &current_lead_ids,
        )
        .execute(&mut **tx)
        .await?;

        for lead in project.leads() {
            sqlx::query!(
                r#"insert into project_lead (project_id, volunteer_id, role, assigned_at)
                   values ($1, $2, $3, $4)
                   on conflict (project_id, volunteer_id) do update set role = excluded.role"#,
                project.id().as_uuid(),
                lead.volunteer_id.as_uuid(),
                lead.role.as_str(),
                lead.assigned_at,
            )
            .execute(&mut **tx)
            .await?;
        }

        Ok(project.take_events())
    }
}

#[async_trait]
impl LeadMembershipQuery for SqlxProjectRepository {
    async fn is_lead_of_project(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
        project_id: ProjectId,
    ) -> Result<bool, RepoError> {
        let exists = sqlx::query_scalar!(
            r#"select exists(
                   select 1 from project_lead where project_id = $1 and volunteer_id = $2
               ) as "exists!""#,
            project_id.as_uuid(),
            volunteer_id.as_uuid()
        )
        .fetch_one(&mut **tx)
        .await?;
        Ok(exists)
    }
}

#[async_trait]
impl UpcomingEventOccurrencesQuery for SqlxProjectRepository {
    async fn find_occurring_within(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        window: Duration,
    ) -> Result<Vec<EventOccurrence>, RepoError> {
        let cutoff = Utc::now() + window;
        let rows = sqlx::query!(
            r#"select id, name, next_occurrence_at as "next_occurrence_at!: chrono::DateTime<chrono::Utc>"
               from project
               where type = 'event' and next_occurrence_at is not null and next_occurrence_at <= $1"#,
            cutoff
        )
        .fetch_all(&mut **tx)
        .await?;

        let mut occurrences = Vec::with_capacity(rows.len());
        for row in rows {
            let project_id: ProjectId = Id::from_uuid(row.id);
            // Every volunteer with an Approved Assignment against this
            // event Project, both Attendee- and Contributor-mode --
            // per projects-assignments.md, the reminder isn't gated by
            // the event-hours distinction.
            let attendee_ids: Vec<uuid::Uuid> = sqlx::query_scalar!(
                r#"select volunteer_id from assignment
                   where project_id = $1 and status = 'approved'"#,
                project_id.as_uuid()
            )
            .fetch_all(&mut **tx)
            .await?;

            occurrences.push(EventOccurrence {
                project_id,
                project_name: row.name,
                next_occurrence_at: row.next_occurrence_at,
                attendee_ids: attendee_ids.into_iter().map(Id::from_uuid).collect(),
            });
        }

        Ok(occurrences)
    }
}

#[async_trait]
pub trait AssignmentRepository: Send + Sync {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: AssignmentId,
    ) -> Result<Option<Assignment>, RepoError>;

    /// Roster view (concept.md section 4).
    async fn find_by_project(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
    ) -> Result<Vec<Assignment>, RepoError>;

    async fn find_by_volunteer(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
    ) -> Result<Vec<Assignment>, RepoError>;

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        assignment: &mut Assignment,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}

pub struct SqlxAssignmentRepository;

#[allow(clippy::too_many_arguments)]
fn row_to_assignment(
    id: uuid::Uuid,
    volunteer_id: uuid::Uuid,
    project_id: uuid::Uuid,
    role: String,
    participation_mode: String,
    status: String,
    applied_at: DateTime<Utc>,
    decided_by: Option<uuid::Uuid>,
    decided_at: Option<DateTime<Utc>>,
    attended_at: Option<DateTime<Utc>>,
) -> Assignment {
    Assignment::from_persisted(
        Id::from_uuid(id),
        Id::from_uuid(volunteer_id),
        Id::from_uuid(project_id),
        role,
        ParticipationMode::parse(&participation_mode)
            .expect("participation_mode column must be valid"),
        AssignmentStatus::parse(&status).expect("status column must be a valid AssignmentStatus"),
        applied_at,
        decided_by.map(Id::from_uuid),
        decided_at,
        attended_at,
    )
}

#[async_trait]
impl AssignmentRepository for SqlxAssignmentRepository {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: AssignmentId,
    ) -> Result<Option<Assignment>, RepoError> {
        let row = sqlx::query!(
            r#"select id, volunteer_id, project_id, role, participation_mode, status,
                      applied_at as "applied_at: chrono::DateTime<chrono::Utc>",
                      decided_by,
                      decided_at as "decided_at: chrono::DateTime<chrono::Utc>",
                      attended_at as "attended_at: chrono::DateTime<chrono::Utc>"
               from assignment where id = $1"#,
            id.as_uuid()
        )
        .fetch_optional(&mut **tx)
        .await?;

        Ok(row.map(|r| {
            row_to_assignment(
                r.id,
                r.volunteer_id,
                r.project_id,
                r.role,
                r.participation_mode,
                r.status,
                r.applied_at,
                r.decided_by,
                r.decided_at,
                r.attended_at,
            )
        }))
    }

    async fn find_by_project(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
    ) -> Result<Vec<Assignment>, RepoError> {
        let rows = sqlx::query!(
            r#"select id, volunteer_id, project_id, role, participation_mode, status,
                      applied_at as "applied_at: chrono::DateTime<chrono::Utc>",
                      decided_by,
                      decided_at as "decided_at: chrono::DateTime<chrono::Utc>",
                      attended_at as "attended_at: chrono::DateTime<chrono::Utc>"
               from assignment where project_id = $1"#,
            project_id.as_uuid()
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                row_to_assignment(
                    r.id,
                    r.volunteer_id,
                    r.project_id,
                    r.role,
                    r.participation_mode,
                    r.status,
                    r.applied_at,
                    r.decided_by,
                    r.decided_at,
                    r.attended_at,
                )
            })
            .collect())
    }

    async fn find_by_volunteer(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer_id: VolunteerId,
    ) -> Result<Vec<Assignment>, RepoError> {
        let rows = sqlx::query!(
            r#"select id, volunteer_id, project_id, role, participation_mode, status,
                      applied_at as "applied_at: chrono::DateTime<chrono::Utc>",
                      decided_by,
                      decided_at as "decided_at: chrono::DateTime<chrono::Utc>",
                      attended_at as "attended_at: chrono::DateTime<chrono::Utc>"
               from assignment where volunteer_id = $1"#,
            volunteer_id.as_uuid()
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                row_to_assignment(
                    r.id,
                    r.volunteer_id,
                    r.project_id,
                    r.role,
                    r.participation_mode,
                    r.status,
                    r.applied_at,
                    r.decided_by,
                    r.decided_at,
                    r.attended_at,
                )
            })
            .collect())
    }

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        assignment: &mut Assignment,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError> {
        sqlx::query!(
            r#"insert into assignment (id, volunteer_id, project_id, role, participation_mode,
                                        status, applied_at, decided_by, decided_at, attended_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               on conflict (id) do update set
                   status = excluded.status,
                   decided_by = excluded.decided_by,
                   decided_at = excluded.decided_at,
                   attended_at = excluded.attended_at"#,
            assignment.id().as_uuid(),
            assignment.volunteer_id().as_uuid(),
            assignment.project_id().as_uuid(),
            assignment.role(),
            assignment.participation_mode().as_str(),
            assignment.status().as_str(),
            assignment.applied_at(),
            assignment.decided_by().map(|id| id.as_uuid()),
            assignment.decided_at(),
            assignment.attended_at(),
        )
        .execute(&mut **tx)
        .await?;

        Ok(assignment.take_events())
    }
}

/// Backs `discord_integration::ActiveProjectMembershipQuery`'s `apps/api`
/// adapter (Prompt 5.1) -- `discord-integration` does not depend on this
/// crate (context-map.md's acyclic graph), so this trait's implementation
/// lives here (the owning context) and the adapter in `apps/api` (the
/// composition root) delegates to it, mirroring `hours-verification`'s
/// `AssignmentSnapshotQuery`/`ProjectsAssignmentsSnapshotAdapter` pattern
/// exactly. Filtered to `Approved` assignments with `Contributor`
/// `participation_mode` only -- reusing Prompt 3.2's construction-time
/// guarantee rather than re-deriving event-hours logic here, per
/// discord-integration.md's explicit instruction.
#[async_trait]
pub trait ActiveContributorMembershipsQuery: Send + Sync {
    async fn active_contributor_memberships(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<(VolunteerId, ProjectId)>, RepoError>;
}

#[async_trait]
impl ActiveContributorMembershipsQuery for SqlxAssignmentRepository {
    async fn active_contributor_memberships(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<(VolunteerId, ProjectId)>, RepoError> {
        let rows = sqlx::query!(
            r#"select volunteer_id, project_id from assignment
               where status = 'approved' and participation_mode = 'contributor'"#
        )
        .fetch_all(&mut **tx)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| (Id::from_uuid(r.volunteer_id), Id::from_uuid(r.project_id)))
            .collect())
    }
}
