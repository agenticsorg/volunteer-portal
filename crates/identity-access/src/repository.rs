use async_trait::async_trait;
use kernel::{DomainEvent, Id, RepoError, Skill, VolunteerId};
use sqlx::{Postgres, Transaction};

use crate::oauth::{OAuthLink, OAuthProvider};
use crate::volunteer::{Agreements, Availability, Role, Volunteer, VolunteerStatus};

#[async_trait]
pub trait VolunteerRepository: Send + Sync {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: VolunteerId,
    ) -> Result<Option<Volunteer>, RepoError>;

    async fn find_by_discord_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        discord_id: &str,
    ) -> Result<Option<Volunteer>, RepoError>;

    async fn find_by_email(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        email: &str,
    ) -> Result<Option<Volunteer>, RepoError>;

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer: &mut Volunteer,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError>;
}

pub struct SqlxVolunteerRepository;

async fn load_oauth_links(
    tx: &mut Transaction<'_, Postgres>,
    volunteer_id: VolunteerId,
) -> Result<Vec<OAuthLink>, RepoError> {
    let rows = sqlx::query!(
        r#"select provider, provider_user_id, email, email_verified,
                  linked_at as "linked_at: chrono::DateTime<chrono::Utc>"
           from identity where volunteer_id = $1"#,
        volunteer_id.as_uuid()
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| OAuthLink {
            provider: OAuthProvider::parse(&r.provider).expect("provider column must be valid"),
            provider_user_id: r.provider_user_id,
            email_at_link_time: r.email,
            email_verified: r.email_verified,
            linked_at: r.linked_at,
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn row_to_volunteer(
    id: uuid::Uuid,
    name: String,
    email: String,
    discord_id: Option<String>,
    timezone: String,
    skills: Vec<String>,
    availability: serde_json::Value,
    status: String,
    role: String,
    code_of_conduct_accepted_at: Option<chrono::DateTime<chrono::Utc>>,
    ip_agreement_accepted_at: Option<chrono::DateTime<chrono::Utc>>,
    age_attestation_confirmed_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: chrono::DateTime<chrono::Utc>,
    oauth_links: Vec<OAuthLink>,
) -> Volunteer {
    Volunteer::from_persisted(
        Id::from_uuid(id),
        name,
        email,
        discord_id,
        timezone,
        skills
            .into_iter()
            .filter_map(|s| Skill::new(s).ok())
            .collect(),
        Availability(availability),
        VolunteerStatus::parse(&status).expect("status column must be a valid VolunteerStatus"),
        Role::parse(&role).expect("role column must be a valid Role"),
        Agreements {
            code_of_conduct_accepted_at,
            ip_agreement_accepted_at,
            age_attestation_confirmed_at,
        },
        oauth_links,
        created_at,
    )
}

#[async_trait]
impl VolunteerRepository for SqlxVolunteerRepository {
    async fn find_by_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: VolunteerId,
    ) -> Result<Option<Volunteer>, RepoError> {
        let row = sqlx::query!(
            r#"select id, name, email, discord_id, timezone, skills, availability,
                      status, role,
                      code_of_conduct_accepted_at as "code_of_conduct_accepted_at: chrono::DateTime<chrono::Utc>",
                      ip_agreement_accepted_at as "ip_agreement_accepted_at: chrono::DateTime<chrono::Utc>",
                      age_attestation_confirmed_at as "age_attestation_confirmed_at: chrono::DateTime<chrono::Utc>",
                      created_at as "created_at: chrono::DateTime<chrono::Utc>"
               from volunteer where id = $1"#,
            id.as_uuid()
        )
        .fetch_optional(&mut **tx)
        .await?;

        let Some(row) = row else { return Ok(None) };
        let links = load_oauth_links(tx, id).await?;
        Ok(Some(row_to_volunteer(
            row.id,
            row.name,
            row.email,
            row.discord_id,
            row.timezone,
            row.skills,
            row.availability,
            row.status,
            row.role,
            row.code_of_conduct_accepted_at,
            row.ip_agreement_accepted_at,
            row.age_attestation_confirmed_at,
            row.created_at,
            links,
        )))
    }

    async fn find_by_discord_id(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        discord_id: &str,
    ) -> Result<Option<Volunteer>, RepoError> {
        let row = sqlx::query!(
            r#"select id, name, email, discord_id, timezone, skills, availability,
                      status, role,
                      code_of_conduct_accepted_at as "code_of_conduct_accepted_at: chrono::DateTime<chrono::Utc>",
                      ip_agreement_accepted_at as "ip_agreement_accepted_at: chrono::DateTime<chrono::Utc>",
                      age_attestation_confirmed_at as "age_attestation_confirmed_at: chrono::DateTime<chrono::Utc>",
                      created_at as "created_at: chrono::DateTime<chrono::Utc>"
               from volunteer where discord_id = $1"#,
            discord_id
        )
        .fetch_optional(&mut **tx)
        .await?;

        let Some(row) = row else { return Ok(None) };
        let id: VolunteerId = Id::from_uuid(row.id);
        let links = load_oauth_links(tx, id).await?;
        Ok(Some(row_to_volunteer(
            row.id,
            row.name,
            row.email,
            row.discord_id,
            row.timezone,
            row.skills,
            row.availability,
            row.status,
            row.role,
            row.code_of_conduct_accepted_at,
            row.ip_agreement_accepted_at,
            row.age_attestation_confirmed_at,
            row.created_at,
            links,
        )))
    }

    async fn find_by_email(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        email: &str,
    ) -> Result<Option<Volunteer>, RepoError> {
        let row = sqlx::query!(
            r#"select id, name, email, discord_id, timezone, skills, availability,
                      status, role,
                      code_of_conduct_accepted_at as "code_of_conduct_accepted_at: chrono::DateTime<chrono::Utc>",
                      ip_agreement_accepted_at as "ip_agreement_accepted_at: chrono::DateTime<chrono::Utc>",
                      age_attestation_confirmed_at as "age_attestation_confirmed_at: chrono::DateTime<chrono::Utc>",
                      created_at as "created_at: chrono::DateTime<chrono::Utc>"
               from volunteer where lower(email) = lower($1)"#,
            email
        )
        .fetch_optional(&mut **tx)
        .await?;

        let Some(row) = row else { return Ok(None) };
        let id: VolunteerId = Id::from_uuid(row.id);
        let links = load_oauth_links(tx, id).await?;
        Ok(Some(row_to_volunteer(
            row.id,
            row.name,
            row.email,
            row.discord_id,
            row.timezone,
            row.skills,
            row.availability,
            row.status,
            row.role,
            row.code_of_conduct_accepted_at,
            row.ip_agreement_accepted_at,
            row.age_attestation_confirmed_at,
            row.created_at,
            links,
        )))
    }

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        volunteer: &mut Volunteer,
    ) -> Result<Vec<Box<dyn DomainEvent>>, RepoError> {
        let skills: Vec<String> = volunteer.skills().iter().map(|s| s.as_str().to_string()).collect();

        sqlx::query!(
            r#"insert into volunteer (
                   id, name, email, discord_id, timezone, skills, availability,
                   status, role, code_of_conduct_accepted_at, ip_agreement_accepted_at,
                   age_attestation_confirmed_at, created_at
               )
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               on conflict (id) do update set
                   name = excluded.name,
                   email = excluded.email,
                   discord_id = excluded.discord_id,
                   timezone = excluded.timezone,
                   skills = excluded.skills,
                   availability = excluded.availability,
                   status = excluded.status,
                   role = excluded.role,
                   code_of_conduct_accepted_at = excluded.code_of_conduct_accepted_at,
                   ip_agreement_accepted_at = excluded.ip_agreement_accepted_at,
                   age_attestation_confirmed_at = excluded.age_attestation_confirmed_at"#,
            volunteer.id().as_uuid(),
            volunteer.name(),
            volunteer.email(),
            volunteer.discord_id(),
            volunteer.timezone(),
            &skills,
            volunteer.availability().0.clone(),
            volunteer.status().as_str(),
            volunteer.role().as_str(),
            volunteer.agreements().code_of_conduct_accepted_at,
            volunteer.agreements().ip_agreement_accepted_at,
            volunteer.agreements().age_attestation_confirmed_at,
            volunteer.created_at(),
        )
        .execute(&mut **tx)
        .await?;

        for link in volunteer.oauth_links() {
            sqlx::query!(
                r#"insert into identity (volunteer_id, provider, provider_user_id, email, email_verified, linked_at)
                   values ($1, $2, $3, $4, $5, $6)
                   on conflict (provider, provider_user_id) do nothing"#,
                volunteer.id().as_uuid(),
                link.provider.as_str(),
                link.provider_user_id,
                link.email_at_link_time,
                link.email_verified,
                link.linked_at,
            )
            .execute(&mut **tx)
            .await?;
        }

        Ok(volunteer.take_events())
    }
}
