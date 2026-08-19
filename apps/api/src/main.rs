use axum::{routing::get, Router};

async fn health() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    // Full composition root (Axum router, auth extractors, audit-framework
    // wiring per ADR-0005) is built in Prompt 1.4. This is intentionally
    // a health-check route only, per Prompt 1.1's scope.
    let app = Router::new().route("/health", get(health));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;

    Ok(())
}
