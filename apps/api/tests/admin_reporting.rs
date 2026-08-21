//! Prompt 8.1 exit criteria (build-roadmap.md's Phase 8 section):
//! - CSV export tested against a non-trivial dataset (pagination/large
//!   roster -- not just a handful of rows).
//! - Hours report totals verified to match source `HourEntry` data
//!   exactly via a reconciliation test (sum the report's output, sum the
//!   raw approved `HourEntry` rows for the same filter, assert
//!   equality).

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, GoogleOAuthClient, GoogleUserInfo, OAuthError};
use api::state::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
use projects_assignments::SqlxProjectRepository;
use rust_decimal::Decimal;
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
        unimplemented!("not exercised by the admin-reporting test suite")
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        unimplemented!("not exercised by the admin-reporting test suite")
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

async fn build_test_app(owner_pool: &PgPool, app_pool: PgPool, discord_user: DiscordUserInfo) -> axum::Router {
    let session_store = tower_sessions_sqlx_store_chrono::PostgresStore::new(owner_pool.clone());
    session_store.migrate().await.unwrap();
    let session_layer = api::session::configure(session_store);

    let state = AppState {
        db: kernel::ScopedDb::new(app_pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        project_names: Arc::new(api::project_name_adapter::ProjectsAssignmentsNameAdapter),
        semantic_match: Arc::new(api::semantic_matching_client::NullSemanticMatchClient),
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

async fn promote_to_admin(app_pool: &PgPool, volunteer_id: uuid::Uuid) {
    use identity_access::{Role, SqlxVolunteerRepository, VolunteerRepository};
    let db = kernel::ScopedDb::new(app_pool.clone());
    let repo = SqlxVolunteerRepository;
    let id = kernel::Id::from_uuid(volunteer_id);
    let mut tx = db.begin_scoped(volunteer_id).await.unwrap();
    let mut volunteer = repo.find_by_id(&mut tx, id).await.unwrap().unwrap();
    volunteer.change_role(Role::Admin, id).unwrap();
    repo.save(&mut tx, &mut volunteer).await.unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn csv_export_includes_every_row_of_a_large_roster_not_a_truncated_page() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "roster-admin".to_string(),
            username: "admin".to_string(),
            email: Some("roster-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (admin_cookie, admin_id) = login(&app, &owner_pool, "roster-admin").await;
    promote_to_admin(&app_pool, admin_id).await;

    // A non-trivial dataset: 150 volunteers, well past any default page
    // size (the paginated JSON view defaults to 50) -- this is exactly
    // the scenario that would silently truncate if the CSV export path
    // ever picked up a default LIMIT instead of `limit: None`.
    const SEEDED_COUNT: i64 = 150;
    for i in 0..SEEDED_COUNT {
        sqlx::query(
            "insert into volunteer (name, email, timezone, status, role) \
             values ($1, $2, 'UTC', 'approved', 'volunteer')",
        )
        .bind(format!("Roster Volunteer {i}"))
        .bind(format!("roster-volunteer-{i}@example.org"))
        .execute(&owner_pool)
        .await
        .unwrap();
    }
    // +1 for the admin actor itself, already seeded via login().
    let expected_total = SEEDED_COUNT + 1;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/admin/volunteers/export.csv")
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers().get("content-type").unwrap(), "text/csv");

    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let mut reader = csv::ReaderBuilder::new().from_reader(bytes.as_ref());
    let rows: Vec<csv::StringRecord> = reader.records().map(|r| r.unwrap()).collect();

    assert_eq!(
        rows.len() as i64,
        expected_total,
        "CSV export must include every matching row, not a truncated page (expected {expected_total}, got {})",
        rows.len()
    );
    // Spot-check: the seeded rows' distinctive names are actually present
    // in the export, not just a matching count by coincidence.
    let names: Vec<&str> = rows.iter().map(|r| r.get(1).unwrap()).collect();
    assert!(names.contains(&"Roster Volunteer 0"));
    assert!(names.contains(&"Roster Volunteer 149"));
}

#[tokio::test]
async fn roster_filters_by_status_role_and_skill() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "filter-admin".to_string(),
            username: "admin".to_string(),
            email: Some("filter-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (admin_cookie, admin_id) = login(&app, &owner_pool, "filter-admin").await;
    promote_to_admin(&app_pool, admin_id).await;

    sqlx::query(
        "insert into volunteer (name, email, timezone, status, role, skills) \
         values ('Pending Carpenter', 'pending-carpenter@example.org', 'UTC', 'pending_approval', 'volunteer', array['carpentry'])",
    )
    .execute(&owner_pool)
    .await
    .unwrap();
    sqlx::query(
        "insert into volunteer (name, email, timezone, status, role, skills) \
         values ('Approved Carpenter', 'approved-carpenter@example.org', 'UTC', 'approved', 'volunteer', array['carpentry'])",
    )
    .execute(&owner_pool)
    .await
    .unwrap();
    sqlx::query(
        "insert into volunteer (name, email, timezone, status, role, skills) \
         values ('Approved Plumber', 'approved-plumber@example.org', 'UTC', 'approved', 'volunteer', array['plumbing'])",
    )
    .execute(&owner_pool)
    .await
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/admin/volunteers?status=approved&skill=carpentry")
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let page: Value = serde_json::from_slice(&bytes).unwrap();

    let names: Vec<&str> = page["rows"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Approved Carpenter"], "must match only approved + carpentry-skilled volunteers");
}

#[tokio::test]
async fn hours_report_totals_reconcile_exactly_with_raw_approved_hour_entry_data() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "report-admin".to_string(),
            username: "admin".to_string(),
            email: Some("report-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (admin_cookie, admin_id) = login(&app, &owner_pool, "report-admin").await;
    promote_to_admin(&app_pool, admin_id).await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "report-volunteer".to_string(),
            username: "volunteer".to_string(),
            email: Some("report-volunteer@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, volunteer_id) = login(&volunteer_app, &owner_pool, "report-volunteer").await;

    let project_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, description, type, status) values ('Reconciliation Project', '', 'project', 'open') returning id",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    sqlx::query("insert into project_lead (project_id, volunteer_id) values ($1, $2)")
        .bind(project_id)
        .bind(admin_id)
        .execute(&owner_pool)
        .await
        .unwrap();
    let assignment_id: uuid::Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status, decided_by, decided_at) \
         values ($1, $2, 'Volunteer', 'contributor', 'approved', $3, now()) returning id",
    )
    .bind(volunteer_id)
    .bind(project_id)
    .bind(admin_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    // In range and approved -- must count.
    for (date, hours) in [("2026-01-05", "2.50"), ("2026-01-20", "3.25")] {
        sqlx::query(
            "insert into hour_entry (volunteer_id, assignment_id, date, hours, description, status, approver_id, decided_at) \
             values ($1, $2, $3, $4, 'x', 'approved', $5, now())",
        )
        .bind(volunteer_id)
        .bind(assignment_id)
        .bind(date.parse::<chrono::NaiveDate>().unwrap())
        .bind(hours.parse::<Decimal>().unwrap())
        .bind(admin_id)
        .execute(&owner_pool)
        .await
        .unwrap();
    }
    // Pending -- must not count.
    sqlx::query(
        "insert into hour_entry (volunteer_id, assignment_id, date, hours, description, status) \
         values ($1, $2, '2026-01-10', 5.00, 'pending entry', 'pending')",
    )
    .bind(volunteer_id)
    .bind(assignment_id)
    .execute(&owner_pool)
    .await
    .unwrap();
    // Approved but outside the queried range -- must not count.
    sqlx::query(
        "insert into hour_entry (volunteer_id, assignment_id, date, hours, description, status, approver_id, decided_at) \
         values ($1, $2, '2025-06-01', 9.00, 'out of range', 'approved', $3, now())",
    )
    .bind(volunteer_id)
    .bind(assignment_id)
    .bind(admin_id)
    .execute(&owner_pool)
    .await
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/admin/reports/hours?project_id={project_id}&start=2026-01-01&end=2026-01-31"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let report: Value = serde_json::from_slice(&bytes).unwrap();

    let report_total: Decimal = report["total_hours"].as_str().unwrap().parse().unwrap();

    // Independently, directly against the raw approved HourEntry data
    // for the same filter -- the reconciliation this exit criterion
    // requires.
    let raw_total: Decimal = sqlx::query_scalar(
        "select coalesce(sum(hours), 0) from hour_entry he \
         join assignment a on a.id = he.assignment_id \
         where a.project_id = $1 and he.status = 'approved' and he.date >= '2026-01-01' and he.date <= '2026-01-31'",
    )
    .bind(project_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    assert_eq!(report_total, raw_total, "report total must reconcile exactly with raw approved HourEntry data");
    assert_eq!(report_total, Decimal::new(575, 2), "sanity check: 2.50 + 3.25 = 5.75");

    let rows = report["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["volunteer_id"], Value::String(volunteer_id.to_string()));
}
