use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;
use crate::TradingApiState;
use crate::session_auth;

pub async fn auth_middleware(
    State(state): State<Arc<TradingApiState>>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = request.uri().path();

    // Skip auth for health check and session auth endpoints
    if path == "/health"
        || path == "/session/auth/challenge"
        || path == "/session/auth/verify"
    {
        return Ok(next.run(request).await);
    }

    let auth_header = request
        .headers()
        .get("authorization")
        .or_else(|| request.headers().get("x-owner-token"))
        .and_then(|v| v.to_str().ok());

    match auth_header {
        Some(header) => {
            let token = if header.starts_with("Bearer ") {
                &header[7..]
            } else {
                header
            };

            // Owner session token (sess_xxx)
            if token.starts_with("sess_") {
                if session_auth::validate_owner_token(token).is_some() {
                    return Ok(next.run(request).await);
                }
                return Err(StatusCode::UNAUTHORIZED);
            }

            // Agent API token (existing auth)
            if token == state.api_token {
                Ok(next.run(request).await)
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
