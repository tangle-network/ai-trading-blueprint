//! OAuth2 + PKCE consent endpoints: authorize preview, consent (`authorize`),
//! and the PKCE token exchange.

use super::*;

#[derive(Deserialize)]
pub(super) struct PreviewQuery {
    bot_id: String,
    network: String,
}

/// `GET /api/trading-desk/authorize/preview?bot_id=&network=`
///
/// Pre-flight for the Arena consent screen: shows what the wallet is about
/// to approve and why it may not be eligible yet.
pub(super) async fn authorize_preview(
    State(state): State<Arc<MultiBotTradingState>>,
    Query(query): Query<PreviewQuery>,
    headers: HeaderMap,
) -> Response {
    let address = match wallet_session_address(&headers) {
        Ok(address) => address,
        Err(response) => return response,
    };
    let chain_id = match network_chain_id(&query.network) {
        Some(chain_id) => chain_id,
        None => return desk_error(StatusCode::BAD_REQUEST, "network must be test or live"),
    };
    let eligibility = check_eligibility(&state, &query.bot_id, &address);

    let payload = json!({
        "botId": query.bot_id,
        "network": query.network,
        "chainId": chain_id,
        "eligible": eligibility.ok(),
        "problems": eligibility.problems,
        "envelope": eligibility.envelope_summary,
        "instruments": instruments_for_chain(chain_id),
        "scopes": ["account:read", "orders:submit", "orders:read", "connection:revoke"],
        "quoteCurrency": QUOTE_CURRENCY,
    });
    (StatusCode::OK, Json(payload)).into_response()
}

#[derive(Deserialize)]
pub(super) struct AuthorizeRequest {
    network: String,
    bot_id: String,
    /// Opaque value echoed back through the redirect (OAuth `state`).
    state: String,
    code_challenge: String,
    #[serde(default = "default_s256")]
    code_challenge_method: String,
    redirect_uri: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

fn default_s256() -> String {
    "S256".to_string()
}

/// `POST /api/trading-desk/authorize`
///
/// Wallet-owner consent: mints a single-use authorization code bound to the
/// PKCE challenge, redirect URI, bot, and network. The desk never sees the
/// session; only the code flows through the browser redirect.
pub(super) async fn authorize(
    State(state): State<Arc<MultiBotTradingState>>,
    headers: HeaderMap,
    Json(body): Json<AuthorizeRequest>,
) -> Response {
    let address = match wallet_session_address(&headers) {
        Ok(address) => address,
        Err(response) => return response,
    };

    if body.state.len() > 1024 {
        return desk_error(StatusCode::BAD_REQUEST, "state too long (max 1024 chars)");
    }
    if body.code_challenge_method != "S256" {
        return desk_error(
            StatusCode::BAD_REQUEST,
            "code_challenge_method must be S256",
        );
    }
    if !valid_code_challenge(&body.code_challenge) {
        return desk_error(StatusCode::BAD_REQUEST, "malformed code_challenge");
    }
    if !redirect_allowlist().contains(&body.redirect_uri) {
        return desk_error(StatusCode::BAD_REQUEST, "redirect_uri is not allowed");
    }
    let Some(chain_id) = network_chain_id(&body.network) else {
        return desk_error(StatusCode::BAD_REQUEST, "network must be test or live");
    };

    let eligibility = check_eligibility(&state, &body.bot_id, &address);
    let bot = match eligibility.require() {
        Ok(bot) => bot,
        Err(response) => return response,
    };
    if bot.chain_id != chain_id {
        return desk_error(
            StatusCode::BAD_REQUEST,
            &format!(
                "bot is on chain {} but network {} maps to chain {}",
                bot.chain_id, body.network, chain_id
            ),
        );
    }
    // A paper-only executor must never be authorized as a live venue.
    if body.network == NETWORK_LIVE && bot.paper_trade {
        return desk_error(
            StatusCode::FORBIDDEN,
            "paper-trading bots cannot be connected on the live network",
        );
    }

    let ttl = body
        .expires_in
        .unwrap_or(DEFAULT_GRANT_TTL_SECS)
        .clamp(MIN_GRANT_TTL_SECS, MAX_GRANT_TTL_SECS);
    let now = now_secs();
    let code = format!("tdsk-code-{}", random_hex(32));
    let grant = DeskGrant {
        grant_id: uuid::Uuid::new_v4().to_string(),
        owner_address: bot.owner_address.clone(),
        bot_id: bot.bot_id.clone(),
        network: body.network.clone(),
        chain_id,
        vault_address: bot.vault_address.clone(),
        redirect_uri: body.redirect_uri.clone(),
        issued_at: now,
        expires_at: now + ttl,
        revoked_at: None,
        last_used_at: None,
        phase: GrantPhase::Pending {
            code_hash: sha256_hex(code.as_bytes()),
            code_challenge: body.code_challenge.clone(),
            code_expires_at: now + CODE_TTL_SECS,
        },
    };

    let _guard = GRANT_WRITE_LOCK.lock().expect("grant write lock");
    let grant_id = grant.grant_id.clone();
    if let Err(err) = GRANTS.insert(format!("grant:{grant_id}"), grant) {
        return desk_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("grant store: {err}"),
        );
    }

    (
        StatusCode::OK,
        Json(json!({
            "code": code,
            "grantId": grant_id,
            "redirectUri": body.redirect_uri,
            "expiresIn": CODE_TTL_SECS,
            "grantExpiresIn": ttl,
        })),
    )
        .into_response()
}

// ── Handler: token exchange (PKCE, desk backend) ─────────────────────────────

#[derive(Deserialize)]
struct TokenForm {
    grant_type: String,
    client_id: String,
    code: String,
    redirect_uri: String,
    code_verifier: String,
}

/// `POST /api/trading-desk/token` (`application/x-www-form-urlencoded`)
///
/// Standard OAuth2 authorization_code + PKCE exchange. The code is
/// single-use: the Pending → Active transition (with the new token hash) is
/// persisted before the token is returned, so a replayed code fails even
/// mid-crash.
pub(super) async fn token_exchange(
    State(state): State<Arc<MultiBotTradingState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    // Parse the form manually so a wrong content-type is a spec-shaped
    // OAuth error instead of an axum extractor rejection (plain-text 415).
    if let Some(problem) = unsupported_media_type(&headers) {
        return problem;
    }
    let form: TokenForm = match serde_urlencoded::from_bytes(&body) {
        Ok(form) => form,
        Err(err) => {
            return oauth_error("invalid_request", &format!("malformed form body: {err}"));
        }
    };
    if form.grant_type != "authorization_code" {
        return oauth_error(
            "unsupported_grant_type",
            "only authorization_code is supported",
        );
    }
    if form.client_id != CLIENT_ID {
        return oauth_error("invalid_client", "unknown client_id");
    }
    if !valid_code_verifier(&form.code_verifier) {
        return oauth_error("invalid_request", "malformed code_verifier");
    }

    let code_hash = sha256_hex(form.code.as_bytes());
    let _guard = GRANT_WRITE_LOCK.lock().expect("grant write lock");

    let grant = GRANTS
        .find(|grant| {
            matches!(&grant.phase, GrantPhase::Pending { code_hash: hash, .. } if *hash == code_hash)
        })
        .ok()
        .flatten();
    let Some(mut grant) = grant else {
        return oauth_error("invalid_grant", "unknown, expired, or already-used code");
    };

    let (code_challenge, code_expires_at) = match &grant.phase {
        GrantPhase::Pending {
            code_challenge,
            code_expires_at,
            ..
        } => (code_challenge.clone(), *code_expires_at),
        _ => return oauth_error("invalid_grant", "code already exchanged"),
    };

    if now_secs() >= code_expires_at {
        return oauth_error("invalid_grant", "code expired");
    }
    if grant.revoked_at.is_some() || now_secs() >= grant.expires_at {
        return oauth_error("invalid_grant", "grant expired or revoked");
    }
    if grant.redirect_uri != form.redirect_uri {
        return oauth_error("invalid_grant", "redirect_uri mismatch");
    }
    if pkce_s256(&form.code_verifier) != code_challenge {
        return oauth_error("invalid_grant", "PKCE verification failed");
    }
    if state
        .desk_resolve_bot
        .as_ref()
        .and_then(|resolve| resolve(&grant.bot_id))
        .is_none()
    {
        return oauth_error("invalid_grant", "bot no longer exists");
    }

    let token = format!("{DESK_TOKEN_PREFIX}{}", random_hex(32));
    let token_hash = sha256_hex(token.as_bytes());
    let expires_in = grant.expires_at.saturating_sub(now_secs());

    // Single-use transition persisted BEFORE the token leaves the process.
    grant.phase = GrantPhase::Active { token_hash };
    if let Err(err) = GRANTS.insert(format!("grant:{}", grant.grant_id), grant) {
        return desk_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("grant store: {err}"),
        );
    }

    (
        StatusCode::OK,
        Json(json!({
            "access_token": token,
            "token_type": "Bearer",
            "expires_in": expires_in,
        })),
    )
        .into_response()
}

fn unsupported_media_type(headers: &HeaderMap) -> Option<Response> {
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase();
    if content_type == "application/x-www-form-urlencoded" {
        None
    } else {
        Some(oauth_error(
            "invalid_request",
            "content-type must be application/x-www-form-urlencoded",
        ))
    }
}
