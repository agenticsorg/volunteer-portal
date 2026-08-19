/// Shared error type for every repository port across every context. A
/// context-specific domain error (e.g. `HourEntryError`) wraps or sits
/// alongside this rather than reimplementing "database failed" /
/// "not found" per crate.
#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
}
