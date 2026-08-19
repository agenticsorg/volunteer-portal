use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Every extractor and handler in this crate maps its failures to one of
/// these, which in turn maps to a clean HTTP status — no auth/authorization
/// failure anywhere in this codebase should ever surface as a 500.
#[derive(Debug)]
pub enum ApiError {
    Unauthorized,
    Forbidden,
    BadRequest,
    NotFound,
    Internal,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::BadRequest => StatusCode::BAD_REQUEST,
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        status.into_response()
    }
}

impl From<kernel::RepoError> for ApiError {
    fn from(_: kernel::RepoError) -> Self {
        ApiError::Internal
    }
}
