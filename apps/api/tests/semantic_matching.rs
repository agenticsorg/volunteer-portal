//! Prompt 9.1 exit criteria (build-roadmap.md's Phase 9 section):
//! - the deterministic SQL directory search remains fully functional
//!   with the semantic-matching layer disabled or erroring;
//! - a suggestion result that would leak a project/volunteer to an
//!   unauthorized user is blocked by a re-checked authorization step,
//!   not merely absent by chance -- this file's fakes deliberately
//!   *inject* an unauthorized id into the semantic service's response
//!   to prove the re-check is what removes it, not luck.

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, GoogleOAuthClient, GoogleUserInfo, OAuthError};
use api::semantic_matching_client::{Collection, MatchItem, MatchResult, SemanticMatchClient, SemanticMatchError};
use api::state::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
use projects_assignments::SqlxProjectRepository;
use serde_json::Value;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use tower::ServiceExt;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

struct FakeDiscordOAuthClient {
    user: DiscordUserInfo,
}

#[async_trait::async_trait]
impl DiscordOAuthClient for FakeDiscordOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, PkceCodeVerifier) {
        (
            "https://discord.com/api/oauth2/authorize?fake=1".parse().unwrap(),
            CsrfToken::new("fake-discord-csrf".to_string()),
            PkceCodeVerifier::new("fake-pkce-verifier".to_string()),
        )
    }
    async fn exchange_code(&self, _code: String, _v: PkceCodeVerifier) -> Result<String, OAuthError> {
        Ok("fake-discord-access-token".to_string())
    }
    async fn fetch_user(&self, _access_token: &str) -> Result<DiscordUserInfo, OAuthError> {
        Ok(self.user.clone())
    }
}

struct UnusedGoogleOAuthClient;
#[async_trait::async_trait]
impl GoogleOAuthClient for UnusedGoogleOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, oauth2::CsrfToken, Nonce) {
        unimplemented!("not exercised by the semantic-matching test suite")
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        unimplemented!("not exercised by the semantic-matching test suite")
    }
}

/// Always errors -- proves the deterministic SQL directory search does
/// not depend on this layer at all.
struct AlwaysErrorsSemanticMatchClient;
#[async_trait::async_trait]
impl SemanticMatchClient for AlwaysErrorsSemanticMatchClient {
    async fn index(&self, _collection: Collection, _items: &[MatchItem]) -> Result<(), SemanticMatchError> {
        Err(SemanticMatchError("service unreachable (test)".to_string()))
    }
    async fn match_query(
        &self,
        _collection: Collection,
        _query: &str,
        _limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError> {
        Err(SemanticMatchError("service unreachable (test)".to_string()))
    }
    async fn match_candidates(
        &self,
        _query: &str,
        _candidates: &[MatchItem],
        _limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError> {
        Err(SemanticMatchError("service unreachable (test)".to_string()))
    }
}

/// A deliberately *adversarial* fake: `match_query` always returns a
/// fixed, attacker-chosen id (`leaked_id`) regardless of what was asked
/// -- standing in for "the semantic-matching service, which holds no
/// authorization context at all, returns a project id it has no way of
/// knowing the caller shouldn't see." The real defense this test proves
/// is entirely in `suggest_projects`'s own re-check, not in this fake
/// behaving itself.
struct InjectsUnauthorizedIdSemanticMatchClient {
    authorized_id: uuid::Uuid,
    leaked_id: uuid::Uuid,
}
#[async_trait::async_trait]
impl SemanticMatchClient for InjectsUnauthorizedIdSemanticMatchClient {
    async fn index(&self, _collection: Collection, _items: &[MatchItem]) -> Result<(), SemanticMatchError> {
        Ok(())
    }
    async fn match_query(
        &self,
        _collection: Collection,
        _query: &str,
        _limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError> {
        // The unauthorized id is ranked *first* (higher score) -- if the
        // re-check were missing or merely happened to filter by
        // position, this ordering would expose that.
        Ok(vec![
            MatchResult { id: self.leaked_id, score: 0.99 },
            MatchResult { id: self.authorized_id, score: 0.5 },
        ])
    }
    async fn match_candidates(
        &self,
        _query: &str,
        candidates: &[MatchItem],
        limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError> {
        // Adversarial here too: tries to inject an id that was never in
        // `candidates` at all, in addition to echoing the real ones.
        let mut results: Vec<MatchResult> =
            candidates.iter().map(|c| MatchResult { id: c.id, score: 0.5 }).collect();
        results.push(MatchResult { id: self.leaked_id, score: 0.99 });
        results.truncate(limit.max(results.len()));
        Ok(results)
    }
}

fn first_cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().to_string()
}

async fn setup() -> (testcontainers_modules::testcontainers::ContainerAsync<Postgres>, PgPool, PgPool) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url = format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();
    (container, owner_pool, app_pool)
}

async fn build_test_app(
    owner_pool: &PgPool,
    app_pool: PgPool,
    discord_user: DiscordUserInfo,
    semantic_match: Arc<dyn SemanticMatchClient>,
) -> axum::Router {
    let session_store = tower_sessions_sqlx_store_chrono::PostgresStore::new(owner_pool.clone());
    session_store.migrate().await.unwrap();
    let session_layer = api::session::configure(session_store);

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        project_names: Arc::new(api::project_name_adapter::ProjectsAssignmentsNameAdapter),
        semantic_match,
        discord_interactions_public_key: "test-public-key".to_string(),
        discord_oauth: Arc::new(FakeDiscordOAuthClient { user: discord_user }),
        google_oauth: Some(Arc::new(UnusedGoogleOAuthClient)),
    };

    api::build_router(state).layer(session_layer)
}

async fn login(app: &axum::Router, owner_pool: &PgPool, discord_id: &str) -> (String, uuid::Uuid) {
    let login_response = app
        .clone()
        .oneshot(Request::builder().uri("/auth/discord/login").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let cookie = first_cookie_pair(login_response.headers().get("set-cookie").unwrap().to_str().unwrap());

    let callback_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/callback?code=x&state=fake-discord-csrf")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let session_cookie =
        first_cookie_pair(callback_response.headers().get("set-cookie").unwrap().to_str().unwrap());

    let volunteer_id: uuid::Uuid = sqlx::query_scalar("select id from volunteer where discord_id = $1")
        .bind(discord_id)
        .fetch_one(owner_pool)
        .await
        .unwrap();

    (session_cookie, volunteer_id)
}

#[tokio::test]
async fn deterministic_directory_search_is_unaffected_when_the_semantic_service_errors() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "deterministic-search".to_string(),
            username: "volunteer".to_string(),
            email: Some("deterministic-search@example.org".to_string()),
            verified: true,
        },
        Arc::new(AlwaysErrorsSemanticMatchClient),
    )
    .await;
    let (cookie, _volunteer_id) = login(&app, &owner_pool, "deterministic-search").await;

    sqlx::query(
        "insert into project (name, description, type, status, needed_skills) \
         values ('Trail Cleanup', '', 'project', 'open', array['carpentry'])",
    )
    .execute(&owner_pool)
    .await
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/projects?skill=carpentry")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "the deterministic SQL directory search must remain fully functional when the semantic-matching service errors on every call"
    );
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let projects: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(projects.as_array().unwrap().len(), 1);
    assert_eq!(projects[0]["name"], "Trail Cleanup");
}

#[tokio::test]
async fn suggest_projects_filters_out_a_suggestion_the_caller_is_not_authorized_to_see() {
    let (_container, owner_pool, app_pool) = setup().await;

    let lead_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "leak-lead".to_string(),
            username: "lead".to_string(),
            email: Some("leak-lead@example.org".to_string()),
            verified: true,
        },
        Arc::new(AlwaysErrorsSemanticMatchClient),
    )
    .await;
    let (_lead_cookie, lead_id) = login(&lead_app, &owner_pool, "leak-lead").await;

    // An OPEN project (any authenticated caller may see it) and a
    // CLOSED project only its lead (or an admin) may see -- the
    // fake client below will suggest *both*.
    let authorized_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, description, type, status) values ('Open To Everyone', '', 'project', 'open') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let unauthorized_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, description, type, status) values ('Closed Lead Only', '', 'project', 'closed') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    sqlx::query("insert into project_lead (project_id, volunteer_id) values ($1, $2)")
        .bind(unauthorized_id)
        .bind(lead_id)
        .execute(&owner_pool)
        .await
        .unwrap();

    let semantic_match = Arc::new(InjectsUnauthorizedIdSemanticMatchClient {
        authorized_id,
        leaked_id: unauthorized_id,
    });

    // An ordinary volunteer: not the lead of the closed project, not an
    // admin. This is the caller whose response must never include the
    // closed project.
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "leak-victim".to_string(),
            username: "volunteer".to_string(),
            email: Some("leak-victim@example.org".to_string()),
            verified: true,
        },
        semantic_match,
    )
    .await;
    let (cookie, _volunteer_id) = login(&app, &owner_pool, "leak-victim").await;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/projects/suggest?skills=anything")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let suggestions: Value = serde_json::from_slice(&bytes).unwrap();
    let ids: Vec<&str> = suggestions.as_array().unwrap().iter().map(|s| s["project_id"].as_str().unwrap()).collect();

    assert!(
        ids.contains(&authorized_id.to_string().as_str()),
        "the authorized (open) project must still be suggested: {suggestions}"
    );
    assert!(
        !ids.contains(&unauthorized_id.to_string().as_str()),
        "the closed project this caller doesn't lead must NEVER appear, even though the (fake, adversarial) \
         semantic-matching service suggested it -- the re-check must have filtered it: {suggestions}"
    );
}

#[tokio::test]
async fn hours_suggestions_never_surfaces_a_project_outside_the_callers_own_assignments() {
    let (_container, owner_pool, app_pool) = setup().await;

    let lead_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "hs-lead".to_string(),
            username: "lead".to_string(),
            email: Some("hs-lead@example.org".to_string()),
            verified: true,
        },
        Arc::new(AlwaysErrorsSemanticMatchClient),
    )
    .await;
    let (_lead_cookie, lead_id) = login(&lead_app, &owner_pool, "hs-lead").await;

    let own_project_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, description, type, status) values ('My Own Project', 'React and design work', 'project', 'open') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let other_volunteer_project_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, description, type, status) values ('Someone Elses Project', 'carpentry work', 'project', 'open') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    sqlx::query("insert into project_lead (project_id, volunteer_id) values ($1, $2), ($3, $2)")
        .bind(own_project_id)
        .bind(lead_id)
        .bind(other_volunteer_project_id)
        .execute(&owner_pool)
        .await
        .unwrap();

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "hs-volunteer".to_string(),
            username: "volunteer".to_string(),
            email: Some("hs-volunteer@example.org".to_string()),
            verified: true,
        },
        Arc::new(AlwaysErrorsSemanticMatchClient),
    )
    .await;
    let (_unused, volunteer_id) = login(&volunteer_app, &owner_pool, "hs-volunteer").await;

    // Only assigned to `own_project_id`, never `other_volunteer_project_id`.
    sqlx::query(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status, decided_by, decided_at) \
         values ($1, $2, 'Volunteer', 'contributor', 'approved', $3, now())",
    )
    .bind(volunteer_id)
    .bind(own_project_id)
    .bind(lead_id)
    .execute(&owner_pool)
    .await
    .unwrap();
    sqlx::query("update volunteer set skills = array['React'] where id = $1")
        .bind(volunteer_id)
        .execute(&owner_pool)
        .await
        .unwrap();

    let semantic_match = Arc::new(InjectsUnauthorizedIdSemanticMatchClient {
        authorized_id: own_project_id,
        leaked_id: other_volunteer_project_id,
    });
    // A fresh app instance wired with the adversarial client, but logging
    // in as the *same* Discord identity ("hs-volunteer") as above -- the
    // OAuth callback finds the existing volunteer row by discord_id, so
    // this is the same volunteer with the same seeded assignment/skills.
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "hs-volunteer".to_string(),
            username: "volunteer".to_string(),
            email: Some("hs-volunteer@example.org".to_string()),
            verified: true,
        },
        semantic_match,
    )
    .await;
    let (cookie, same_volunteer_id) = login(&app, &owner_pool, "hs-volunteer").await;
    assert_eq!(same_volunteer_id, volunteer_id, "must re-login as the same volunteer whose assignment was seeded");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/volunteers/me/hours-suggestions")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let suggestions: Value = serde_json::from_slice(&bytes).unwrap();
    let ids: Vec<&str> = suggestions.as_array().unwrap().iter().map(|s| s["project_id"].as_str().unwrap()).collect();

    assert!(ids.contains(&own_project_id.to_string().as_str()));
    assert!(
        !ids.contains(&other_volunteer_project_id.to_string().as_str()),
        "a project this volunteer has no assignment to must never appear, even though the (fake, adversarial) \
         semantic-matching service tried to inject it: {suggestions}"
    );
}
