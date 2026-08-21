//! Prompt 6.1 exit criteria (build-roadmap.md's Phase 6 section, closed
//! in full by this suite per implementation-prompts.md):
//! - the generated PDF is validated against a real PDF/UA-1 conformance
//!   checker (veraPDF), not just trusted on the strength of the
//!   `--pdf-standard ua-1`-equivalent flag existing (ADR-0009);
//! - letters are generated only from `approved` `HourEntry` rows --
//!   pending/rejected hours never appear;
//! - brand compliance (colors, no em/en dashes) is covered separately in
//!   `verification_letter_render`'s unit tests, since that's a static
//!   property of the template source, not something that needs a live
//!   database;
//! - no letter is ever persisted -- regenerated on each request from
//!   source data.

use std::sync::Arc;

use api::oauth::{DiscordOAuthClient, DiscordUserInfo, GoogleOAuthClient, GoogleUserInfo, OAuthError};
use api::state::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use identity_access::{Role, SqlxVolunteerRepository, VolunteerRepository};
use oauth2::{CsrfToken, PkceCodeVerifier};
use openidconnect::Nonce;
use projects_assignments::SqlxProjectRepository;
use sqlx::PgPool;
use testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};
use tower::ServiceExt;
use tower_sessions::Session;
use tower_sessions_sqlx_store_chrono::PostgresStore;

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
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, Nonce) {
        unimplemented!("not exercised by the verification-letter test suite")
    }
    async fn exchange_code(&self, _code: String, _nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        unimplemented!("not exercised by the verification-letter test suite")
    }
}

fn first_cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().to_string()
}

async fn setup() -> (
    testcontainers_modules::testcontainers::ContainerAsync<Postgres>,
    PgPool,
    PgPool,
) {
    let container = Postgres::default().start().await.unwrap();
    let host_port = container.get_host_port_ipv4(5432).await.unwrap();
    let owner_url = format!("postgres://postgres:postgres@127.0.0.1:{host_port}/postgres");
    let owner_pool = PgPool::connect(&owner_url).await.unwrap();
    MIGRATOR.run(&owner_pool).await.unwrap();
    let app_url = format!("postgres://app_user:app_user_dev_password@127.0.0.1:{host_port}/postgres");
    let app_pool = PgPool::connect(&app_url).await.unwrap();
    (container, owner_pool, app_pool)
}

async fn test_login(session: Session, axum::extract::Path(volunteer_id): axum::extract::Path<uuid::Uuid>) -> impl IntoResponse {
    session
        .insert(api::auth::SESSION_VOLUNTEER_ID_KEY, volunteer_id)
        .await
        .unwrap();
    StatusCode::OK
}

async fn build_test_app(owner_pool: &PgPool, app_pool: PgPool, discord_user: DiscordUserInfo) -> axum::Router {
    let session_store = PostgresStore::new(owner_pool.clone());
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

    api::build_router(state.clone())
        .merge(
            axum::Router::new()
                .route("/test/login/{volunteer_id}", post(test_login))
                .with_state(state),
        )
        .layer(session_layer)
}

async fn test_login_as(app: &axum::Router, volunteer_id: uuid::Uuid) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/test/login/{volunteer_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    first_cookie_pair(response.headers().get("set-cookie").unwrap().to_str().unwrap())
}

async fn login(app: &axum::Router, owner_pool: &PgPool, discord_id: &str) -> (String, uuid::Uuid) {
    let login_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/discord/login")
                .body(Body::empty())
                .unwrap(),
        )
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

    let volunteer_id: uuid::Uuid =
        sqlx::query_scalar("select id from volunteer where discord_id = $1")
            .bind(discord_id)
            .fetch_one(owner_pool)
            .await
            .unwrap();

    (session_cookie, volunteer_id)
}

async fn promote_to_lead(app_pool: &PgPool, volunteer_id: uuid::Uuid) {
    let db = kernel::ScopedDb::new(app_pool.clone());
    let repo = SqlxVolunteerRepository;
    let id = kernel::Id::from_uuid(volunteer_id);
    let mut tx = db.begin_scoped(volunteer_id).await.unwrap();
    let mut volunteer = repo.find_by_id(&mut tx, id).await.unwrap().unwrap();
    volunteer.change_role(Role::Lead, id).unwrap();
    repo.save(&mut tx, &mut volunteer).await.unwrap();
    tx.commit().await.unwrap();
}

async fn promote_to_admin(app_pool: &PgPool, volunteer_id: uuid::Uuid) {
    let db = kernel::ScopedDb::new(app_pool.clone());
    let repo = SqlxVolunteerRepository;
    let id = kernel::Id::from_uuid(volunteer_id);
    let mut tx = db.begin_scoped(volunteer_id).await.unwrap();
    let mut volunteer = repo.find_by_id(&mut tx, id).await.unwrap().unwrap();
    volunteer.change_role(Role::Admin, id).unwrap();
    repo.save(&mut tx, &mut volunteer).await.unwrap();
    tx.commit().await.unwrap();
}

/// Seeds an approved `Contributor`-mode assignment against a project with
/// the given name, directly (bypassing HTTP -- the apply+approve HTTP
/// flow is Prompt 3.3's own coverage).
async fn seed_approved_contributor_assignment(
    owner_pool: &PgPool,
    volunteer_id: uuid::Uuid,
    lead_id: uuid::Uuid,
    project_name: &str,
) -> (uuid::Uuid, uuid::Uuid) {
    let project_id: uuid::Uuid = sqlx::query_scalar(
        "insert into project (name, description, type, status) \
         values ($1, '', 'project', 'open') returning id",
    )
    .bind(project_name)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    sqlx::query("insert into project_lead (project_id, volunteer_id) values ($1, $2)")
        .bind(project_id)
        .bind(lead_id)
        .execute(owner_pool)
        .await
        .unwrap();
    let assignment_id: uuid::Uuid = sqlx::query_scalar(
        "insert into assignment (volunteer_id, project_id, role, participation_mode, status, decided_by, decided_at) \
         values ($1, $2, 'Volunteer', 'contributor', 'approved', $3, now()) returning id",
    )
    .bind(volunteer_id)
    .bind(project_id)
    .bind(lead_id)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    (project_id, assignment_id)
}

#[allow(clippy::too_many_arguments)]
async fn seed_hour_entry(
    owner_pool: &PgPool,
    volunteer_id: uuid::Uuid,
    assignment_id: uuid::Uuid,
    date: chrono::NaiveDate,
    hours: &str,
    status: &str,
    approver_id: Option<uuid::Uuid>,
) -> uuid::Uuid {
    sqlx::query_scalar(
        "insert into hour_entry (volunteer_id, assignment_id, date, hours, description, status, approver_id, decided_at) \
         values ($1, $2, $3, $4, 'Test entry', $5, $6, case when $5 = 'pending' then null else now() end) \
         returning id",
    )
    .bind(volunteer_id)
    .bind(assignment_id)
    .bind(date)
    .bind(hours.parse::<rust_decimal::Decimal>().unwrap())
    .bind(status)
    .bind(approver_id)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

/// Locates the veraPDF CLI jar `scripts/verapdf/build.sh` produces.
/// ADR-0009 names this a non-negotiable Phase 6 gate, so this panics
/// with an actionable message rather than silently skipping when the
/// jar isn't present -- CI always builds it first (see
/// `.github/workflows/ci.yml`); a local run needs
/// `scripts/verapdf/build.sh` run once first.
fn verapdf_jar_path() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("VERAPDF_CLI_JAR") {
        return std::path::PathBuf::from(path);
    }
    let fallback = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/verapdf/target/verapdf-cli.jar");
    if fallback.exists() {
        return fallback;
    }
    panic!(
        "veraPDF CLI jar not found (checked $VERAPDF_CLI_JAR and {}). \
         Run scripts/verapdf/build.sh once to build it -- ADR-0009 names \
         real PDF/UA conformance validation a non-negotiable Phase 6 gate, \
         not something this suite can silently skip.",
        fallback.display()
    );
}

/// Shells out to the real veraPDF CLI (built by `scripts/verapdf/build.sh`)
/// and asserts the given PDF bytes are PDF/UA-1 compliant -- per ADR-0009,
/// trusting `typst_pdf`'s `PdfStandard::Ua_1` flag alone is explicitly not
/// sufficient proof.
fn assert_pdf_ua1_compliant(pdf_bytes: &[u8]) {
    let jar = verapdf_jar_path();
    let dir = std::env::temp_dir().join(format!("verification-letter-verapdf-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let pdf_path = dir.join("letter.pdf");
    std::fs::write(&pdf_path, pdf_bytes).unwrap();

    let output = std::process::Command::new("java")
        .args([
            "-cp",
            jar.to_str().unwrap(),
            "org.verapdf.apps.GreenfieldCliWrapper",
            "-f",
            "ua1",
            "--format",
            "json",
        ])
        .arg(&pdf_path)
        .output()
        .expect("failed to invoke the veraPDF CLI jar");

    let _ = std::fs::remove_dir_all(&dir);

    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("veraPDF must produce valid JSON output");
    let compliant = report["report"]["jobs"][0]["validationResult"][0]["compliant"]
        .as_bool()
        .expect("veraPDF report must carry a compliant field");
    assert!(
        compliant,
        "generated verification letter is not PDF/UA-1 compliant per veraPDF: {report:#}"
    );
}

#[tokio::test]
async fn letter_reflects_only_approved_hours_is_pdf_ua_compliant_and_regenerates_on_each_request() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "letter-lead".to_string(),
            username: "lead".to_string(),
            email: Some("letter-lead@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_lead_cookie, lead_id) = login(&app, &owner_pool, "letter-lead").await;
    promote_to_lead(&app_pool, lead_id).await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "letter-volunteer".to_string(),
            username: "volunteer".to_string(),
            email: Some("letter-volunteer@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, volunteer_id) = login(&volunteer_app, &owner_pool, "letter-volunteer").await;
    let volunteer_cookie = test_login_as(&app, volunteer_id).await;

    let admin_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "letter-admin".to_string(),
            username: "admin".to_string(),
            email: Some("letter-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, admin_id) = login(&admin_app, &owner_pool, "letter-admin").await;
    promote_to_admin(&app_pool, admin_id).await;
    let admin_cookie = test_login_as(&app, admin_id).await;

    let (_trail_project, trail_assignment) =
        seed_approved_contributor_assignment(&owner_pool, volunteer_id, lead_id, "Trail Cleanup").await;
    let (_kitchen_project, kitchen_assignment) =
        seed_approved_contributor_assignment(&owner_pool, volunteer_id, lead_id, "Kitchen Duty").await;

    let mid_january = chrono::NaiveDate::from_ymd_opt(2026, 1, 15).unwrap();
    let approved_entry_id = seed_hour_entry(
        &owner_pool,
        volunteer_id,
        trail_assignment,
        mid_january,
        "5.00",
        "approved",
        Some(lead_id),
    )
    .await;
    // Pending/rejected entries against a *different* project -- if these
    // ever leaked into the letter, "Kitchen Duty" would appear in the
    // extracted text below.
    seed_hour_entry(&owner_pool, volunteer_id, kitchen_assignment, mid_january, "3.00", "pending", None).await;
    seed_hour_entry(
        &owner_pool,
        volunteer_id,
        kitchen_assignment,
        mid_january,
        "2.00",
        "rejected",
        Some(lead_id),
    )
    .await;
    // Also outside the queried date range -- must not appear in the total.
    seed_hour_entry(
        &owner_pool,
        volunteer_id,
        trail_assignment,
        chrono::NaiveDate::from_ymd_opt(2025, 6, 1).unwrap(),
        "9.00",
        "approved",
        Some(lead_id),
    )
    .await;

    let hour_entry_count_before: i64 = sqlx::query_scalar("select count(*) from hour_entry")
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    let audit_log_count_before: i64 = sqlx::query_scalar("select count(*) from audit_log")
        .fetch_one(&owner_pool)
        .await
        .unwrap();

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/volunteers/{volunteer_id}/verification-letter?start=2026-01-01&end=2026-01-31"))
                .header("cookie", &volunteer_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "application/pdf"
    );
    let pdf_bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(pdf_bytes.starts_with(b"%PDF-"), "response body must be a real PDF");

    // No side effects: generating a letter is a pure read over already-
    // approved data (ADR-0009's "rendered on demand ... never stored").
    let hour_entry_count_after: i64 = sqlx::query_scalar("select count(*) from hour_entry")
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    let audit_log_count_after: i64 = sqlx::query_scalar("select count(*) from audit_log")
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(hour_entry_count_before, hour_entry_count_after);
    assert_eq!(audit_log_count_before, audit_log_count_after);

    let text = pdf_extract::extract_text_from_mem(&pdf_bytes).expect("must be able to extract text from the PDF");
    assert!(text.contains("Trail Cleanup"), "approved project must appear: {text}");
    assert!(text.contains("5.00"), "approved hours must appear: {text}");
    assert!(
        !text.contains("Kitchen Duty"),
        "a project with only pending/rejected hours must never appear: {text}"
    );
    assert!(
        !text.contains("9.00"),
        "an approved entry outside the queried date range must not be counted: {text}"
    );

    assert_pdf_ua1_compliant(&pdf_bytes);

    // Regeneration proof: adjust the approved entry's hours via the real
    // admin endpoint, then request the letter again -- if it were cached
    // from the first request instead of rebuilt from source, this would
    // still show "5.00".
    let adjust_body = serde_json::json!({ "new_hours": "8.00", "reason": "Corrected undercount" });
    let adjust_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/admin/hours/{approved_entry_id}/adjust"))
                .header("cookie", &admin_cookie)
                .header("content-type", "application/json")
                .body(Body::from(adjust_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(adjust_response.status(), StatusCode::NO_CONTENT);

    let second_response = app
        .oneshot(
            Request::builder()
                .uri(format!("/volunteers/{volunteer_id}/verification-letter?start=2026-01-01&end=2026-01-31"))
                .header("cookie", &volunteer_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second_response.status(), StatusCode::OK);
    let second_pdf_bytes = axum::body::to_bytes(second_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let second_text =
        pdf_extract::extract_text_from_mem(&second_pdf_bytes).expect("must be able to extract text from the PDF");
    assert!(
        second_text.contains("8.00"),
        "regenerated letter must reflect the post-adjustment total, not a cached one: {second_text}"
    );
    assert!(!second_text.contains("5.00 "), "the stale pre-adjustment total must not survive: {second_text}");
}

#[tokio::test]
async fn only_the_volunteer_themselves_or_an_admin_can_generate_a_letter() {
    let (_container, owner_pool, app_pool) = setup().await;
    let app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "auth-lead".to_string(),
            username: "lead".to_string(),
            email: Some("auth-lead@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_lead_cookie, lead_id) = login(&app, &owner_pool, "auth-lead").await;
    promote_to_lead(&app_pool, lead_id).await;

    let volunteer_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "auth-volunteer".to_string(),
            username: "volunteer".to_string(),
            email: Some("auth-volunteer@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, volunteer_id) = login(&volunteer_app, &owner_pool, "auth-volunteer").await;

    let stranger_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "auth-stranger".to_string(),
            username: "stranger".to_string(),
            email: Some("auth-stranger@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, stranger_id) = login(&stranger_app, &owner_pool, "auth-stranger").await;
    let stranger_cookie = test_login_as(&app, stranger_id).await;

    let admin_app = build_test_app(
        &owner_pool,
        app_pool.clone(),
        DiscordUserInfo {
            id: "auth-admin".to_string(),
            username: "admin".to_string(),
            email: Some("auth-admin@example.org".to_string()),
            verified: true,
        },
    )
    .await;
    let (_unused, admin_id) = login(&admin_app, &owner_pool, "auth-admin").await;
    promote_to_admin(&app_pool, admin_id).await;
    let admin_cookie = test_login_as(&app, admin_id).await;

    let stranger_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/volunteers/{volunteer_id}/verification-letter?start=2026-01-01&end=2026-01-31"))
                .header("cookie", &stranger_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        stranger_response.status(),
        StatusCode::FORBIDDEN,
        "a volunteer must not be able to generate another volunteer's letter"
    );

    let admin_response = app
        .oneshot(
            Request::builder()
                .uri(format!("/volunteers/{volunteer_id}/verification-letter?start=2026-01-01&end=2026-01-31"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(admin_response.status(), StatusCode::OK, "an admin must be able to generate any volunteer's letter");
}
