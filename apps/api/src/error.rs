use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// Every extractor and handler in this crate maps its failures to one of
/// these, which in turn maps to a clean HTTP status — no auth/authorization
/// failure anywhere in this codebase should ever surface as a 500.
#[derive(Debug)]
pub enum ApiError {
    Unauthorized,
    Forbidden,
    BadRequest,
    NotFound,
    /// ADR-0007's account-linking collision: a different, already-
    /// verified identity owns this email. Carries the provider the
    /// caller should sign in with instead, matching the explicit prompt
    /// ADR-0007 specifies ("sign in with that provider, then link this
    /// one from your account settings") rather than a bare status code.
    AccountExistsUnderOtherProvider { provider: &'static str },
    Internal,
}

#[derive(Serialize)]
struct AccountCollisionBody {
    error: &'static str,
    existing_provider: &'static str,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED.into_response(),
            ApiError::Forbidden => StatusCode::FORBIDDEN.into_response(),
            ApiError::BadRequest => StatusCode::BAD_REQUEST.into_response(),
            ApiError::NotFound => StatusCode::NOT_FOUND.into_response(),
            ApiError::AccountExistsUnderOtherProvider { provider } => (
                StatusCode::CONFLICT,
                Json(AccountCollisionBody {
                    error: "account_exists_under_other_provider",
                    existing_provider: provider,
                }),
            )
                .into_response(),
            ApiError::Internal => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
}

impl From<kernel::RepoError> for ApiError {
    fn from(_: kernel::RepoError) -> Self {
        ApiError::Internal
    }
}
