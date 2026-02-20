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
            let token = if header.len() > 7 && header.starts_with("Bearer ") {
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

/// Auth middleware for the multi-bot trading HTTP API.
///
/// Resolves the calling bot by matching the bearer token via the
/// `resolve_bot` function on `MultiBotTradingState`. On match, inserts
/// a `BotContext` into request extensions so route handlers can access it.
pub async fn multi_bot_auth_middleware(
    State(state): State<Arc<crate::MultiBotTradingState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = request.uri().path();

    // Skip auth for health check
    if path == "/health" {
        return Ok(next.run(request).await);
    }

    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    let token = match auth_header {
        Some(header) if header.len() > 7 && header.starts_with("Bearer ") => &header[7..],
        Some(header) => header,
        None => return Err(StatusCode::UNAUTHORIZED),
    };

    // Look up bot by api_token via injected resolver
    match (state.resolve_bot)(token) {
        Some(ctx) => {
            request.extensions_mut().insert(ctx);
            Ok(next.run(request).await)
        }
        None => Err(StatusCode::UNAUTHORIZED),
    }
}
