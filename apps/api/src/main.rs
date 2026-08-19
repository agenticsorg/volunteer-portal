use std::sync::Arc;

use api::state::{AppState, StubLeadMembershipQuery};
use sqlx::PgPool;
use tower_sessions::SessionManagerLayer;
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
    let session_layer = SessionManagerLayer::new(session_store);

    let state = AppState {
        db: kernel::ScopedDb::new(pool),
        lead_membership: Arc::new(StubLeadMembershipQuery),
    };

    let app = api::build_router(state).layer(session_layer);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;

    Ok(())
}
