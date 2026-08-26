use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// Typed application error. Every fallible handler returns `Result<T, AppError>`
/// rather than unwrapping — see SDD/29-definition-of-done.md ("no unwrap() on
/// paths that can legitimately fail").
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    // Reserved for read endpoints that must distinguish "doesn't exist" from
    // "exists but you can't see it" (e.g. attachment download, phase-07+);
    // current routes intentionally collapse both into Forbidden/404-alike
    // responses to avoid leaking existence to non-members.
    #[allow(dead_code)]
    #[error("not found")]
    NotFound,
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("rate limited")]
    RateLimited,
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
    #[error("database error")]
    Database(#[from] sqlx::Error),
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            AppError::NotFound => "not_found",
            AppError::Unauthorized => "unauthorized",
            AppError::Forbidden => "forbidden",
            AppError::Conflict(_) => "conflict",
            AppError::Validation(_) => "validation_error",
            AppError::RateLimited => "rate_limited",
            AppError::Internal(_) => "internal_error",
            AppError::Database(_) => "internal_error",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden => StatusCode::FORBIDDEN,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Validation(_) => StatusCode::BAD_REQUEST,
            AppError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            AppError::Internal(_) | AppError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Never leak internals (queries, stack context) to the client; log
        // the real cause server-side instead (SEC-NFR: no secrets/internal
        // detail in client-facing error bodies).
        if matches!(self, AppError::Internal(_) | AppError::Database(_)) {
            tracing::error!(error = %self, "internal error");
        }
        let body = Json(json!({
            "code": self.code(),
            "message": self.to_string(),
        }));
        (self.status(), body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
