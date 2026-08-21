use std::sync::Arc;

use api::oauth::{RealDiscordOAuthClient, RealGoogleOAuthClient};
use api::state::AppState;
use projects_assignments::SqlxProjectRepository;
use sqlx::PgPool;
use tower_sessions_sqlx_store_chrono::PostgresStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let database_url = std::env::var("APP_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .expect("APP_DATABASE_URL or DATABASE_URL must be set");
    let pool = PgPool::connect(&database_url).await?;

    let session_store = PostgresStore::new(pool.clone());
    session_store.migrate().await?;
    let session_layer = api::session::configure(session_store);

    let discord_oauth = RealDiscordOAuthClient::new(
        std::env::var("DISCORD_CLIENT_ID").expect("DISCORD_CLIENT_ID must be set"),
        std::env::var("DISCORD_CLIENT_SECRET").expect("DISCORD_CLIENT_SECRET must be set"),
        std::env::var("DISCORD_REDIRECT_URI").expect("DISCORD_REDIRECT_URI must be set"),
    );

    // Google is the ADR-0007 "fallback" provider — unlike Discord, its
    // absence at startup isn't fatal (no credentials in this
    // environment); the Google routes 404 until it's configured.
    let google_oauth = match (
        std::env::var("GOOGLE_CLIENT_ID"),
        std::env::var("GOOGLE_CLIENT_SECRET"),
        std::env::var("GOOGLE_REDIRECT_URI"),
    ) {
        (Ok(id), Ok(secret), Ok(redirect_uri)) => {
            match RealGoogleOAuthClient::new(id, secret, redirect_uri).await {
                Ok(client) => Some(Arc::new(client) as Arc<dyn api::oauth::GoogleOAuthClient>),
                Err(err) => {
                    tracing::warn!("Google OAuth client failed to initialize: {err}");
                    None
                }
            }
        }
        _ => {
            tracing::info!(
                "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI not set; Google login disabled"
            );
            None
        }
    };

    // ADR-0013: the semantic-matching service is additive, never load-
    // bearing (the deterministic SQL directory search works with this
    // layer disabled or erroring) -- unlike Discord's mandatory-provider
    // `.expect()` above, an unset URL just defaults to the service's own
    // documented default port rather than failing startup.
    let semantic_matching_url = std::env::var("SEMANTIC_MATCHING_URL")
        .unwrap_or_else(|_| "http://localhost:8081".to_string());

    let state = AppState {
        db: kernel::ScopedDb::new(pool),
        lead_membership: Arc::new(SqlxProjectRepository),
        assignment_snapshot: Arc::new(api::assignment_snapshot_adapter::ProjectsAssignmentsSnapshotAdapter),
        project_names: Arc::new(api::project_name_adapter::ProjectsAssignmentsNameAdapter),
        semantic_match: Arc::new(api::semantic_matching_client::HttpSemanticMatchClient::new(
            semantic_matching_url,
        )),
        discord_interactions_public_key: std::env::var("DISCORD_PUBLIC_KEY")
            .expect("DISCORD_PUBLIC_KEY must be set"),
        discord_oauth: Arc::new(discord_oauth),
        google_oauth,
    };

    let app = api::build_router(state).layer(session_layer);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;

    Ok(())
}
