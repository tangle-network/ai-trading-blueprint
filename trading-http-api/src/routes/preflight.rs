//! `POST /v1/execute/preflight` — opt-in pre-flight simulation against an
//! Anvil fork.
//!
//! Mirrors the body shape of `/v1/execute` semantically (operator submits
//! the call they intend to issue) but never touches mainnet. Returns a
//! structured `PreflightResult` so operators can route on `pass=false`
//! without burning gas on a guaranteed revert.

use std::sync::Arc;

use alloy::primitives::{Address, Bytes, U256};
use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use serde::{Deserialize, Serialize};

use trading_runtime::simulator::preflight::{
    AaveHealthContext, PreflightConfig, PreflightRequest, PreflightResult, PreflightSimulator,
};

use crate::{MultiBotTradingState, TradingApiState};

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/v1/execute/preflight", post(preflight))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/v1/execute/preflight", post(preflight_multi_bot))
}

/// Wire-format pre-flight request. Strings are used for chain values to
/// match the rest of the HTTP API (which speaks decimal strings) and to
/// avoid JSON's lossy 64-bit number range for `U256` fields.
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct PreflightRequestBody {
    pub chain_id: u64,
    pub vault: String,
    pub target: String,
    /// Decimal string. Defaults to "0".
    #[serde(default)]
    pub value: Option<String>,
    /// 0x-prefixed hex calldata.
    pub data: String,
    /// Output token address. Pass the zero address to skip balance/slippage checks.
    pub output_token: String,
    /// Decimal string. Defaults to "0".
    #[serde(default)]
    pub min_output: Option<String>,
    /// Optional Aave V3 health-factor context.
    #[serde(default)]
    pub aave: Option<AaveContextBody>,
    /// Optional pinned fork block.
    #[serde(default)]
    pub fork_block: Option<u64>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct AaveContextBody {
    pub pool: String,
    pub account: String,
}

/// Wire-format response. `U256` fields are serialised as decimal strings to
/// stay JSON-safe.
#[derive(Serialize, Debug, Clone)]
pub struct PreflightResponseBody {
    pub pass: bool,
    pub predicted_output: String,
    pub predicted_health_factor: Option<String>,
    pub gas_estimate: u64,
    pub reason: Option<String>,
    pub balance_before: String,
    pub balance_after: String,
}

impl From<PreflightResult> for PreflightResponseBody {
    fn from(value: PreflightResult) -> Self {
        Self {
            pass: value.pass,
            predicted_output: value.predicted_output.to_string(),
            predicted_health_factor: value.predicted_health_factor.map(|v| v.to_string()),
            gas_estimate: value.gas_estimate,
            reason: value.reason,
            balance_before: value.balance_before.to_string(),
            balance_after: value.balance_after.to_string(),
        }
    }
}

impl PreflightRequestBody {
    /// Translate the wire-format body into the runtime request, validating
    /// every address + decimal string at the boundary so the simulator only
    /// has to deal with well-formed types.
    pub fn into_runtime(self) -> Result<PreflightRequest, String> {
        let vault = parse_address("vault", &self.vault)?;
        let target = parse_address("target", &self.target)?;
        let output_token = parse_address("output_token", &self.output_token)?;
        let value = parse_u256("value", self.value.as_deref().unwrap_or("0"))?;
        let min_output = parse_u256("min_output", self.min_output.as_deref().unwrap_or("0"))?;
        let data = parse_hex_bytes("data", &self.data)?;
        let aave = self
            .aave
            .map(|ctx| -> Result<AaveHealthContext, String> {
                Ok(AaveHealthContext {
                    pool: parse_address("aave.pool", &ctx.pool)?,
                    account: parse_address("aave.account", &ctx.account)?,
                })
            })
            .transpose()?;

        Ok(PreflightRequest {
            chain_id: self.chain_id,
            vault,
            target,
            value,
            data,
            output_token,
            min_output,
            aave,
            fork_block: self.fork_block,
        })
    }
}

fn parse_address(field: &str, raw: &str) -> Result<Address, String> {
    raw.trim()
        .parse::<Address>()
        .map_err(|e| format!("invalid {field} address '{raw}': {e}"))
}

fn parse_u256(field: &str, raw: &str) -> Result<U256, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(U256::ZERO);
    }
    if let Some(stripped) = trimmed.strip_prefix("0x") {
        return U256::from_str_radix(stripped, 16)
            .map_err(|e| format!("invalid {field} hex value '{raw}': {e}"));
    }
    U256::from_str_radix(trimmed, 10)
        .map_err(|e| format!("invalid {field} decimal value '{raw}': {e}"))
}

fn parse_hex_bytes(field: &str, raw: &str) -> Result<Bytes, String> {
    let stripped = raw.trim().strip_prefix("0x").unwrap_or(raw.trim());
    if stripped.is_empty() {
        return Ok(Bytes::new());
    }
    let bytes =
        hex::decode(stripped).map_err(|e| format!("invalid {field} hex bytes '{raw}': {e}"))?;
    Ok(Bytes::from(bytes))
}

async fn preflight(
    State(state): State<Arc<TradingApiState>>,
    Json(body): Json<PreflightRequestBody>,
) -> Result<Json<PreflightResponseBody>, (StatusCode, String)> {
    let req = body
        .into_runtime()
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    let config = build_preflight_config(state.rpc_url.as_deref());
    run_preflight(config, req).await
}

async fn preflight_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    request: axum::extract::Request,
) -> Result<Json<PreflightResponseBody>, (StatusCode, String)> {
    let bot = request
        .extensions()
        .get::<crate::BotContext>()
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Bot context not resolved — check auth middleware".to_string(),
            )
        })?;
    let body_bytes = axum::body::to_bytes(request.into_body(), 64 * 1024)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Body read failed: {e}")))?;
    let body: PreflightRequestBody = serde_json::from_slice(&body_bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid JSON: {e}")))?;
    let req = body
        .into_runtime()
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    let config = build_preflight_config(Some(bot.rpc_url.as_str()));
    run_preflight(config, req).await
}

/// Build the simulator config — falls back to env config when no RPC URL
/// is wired into the bot/operator state.
fn build_preflight_config(rpc_url: Option<&str>) -> PreflightConfig {
    let mut config = PreflightConfig::default();
    if config.fork_rpc_url.is_none()
        && let Some(url) = rpc_url.map(str::trim).filter(|value| !value.is_empty())
    {
        config = config.with_rpc_url(url);
    }
    config
}

async fn run_preflight(
    config: PreflightConfig,
    req: PreflightRequest,
) -> Result<Json<PreflightResponseBody>, (StatusCode, String)> {
    if config.fork_rpc_url.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "preflight unavailable: configure PREFLIGHT_FORK_RPC_URL or operator RPC URL"
                .to_string(),
        ));
    }
    let simulator = PreflightSimulator::new(config);
    tracing::info!(
        chain_id = req.chain_id,
        vault = %req.vault,
        target = %req.target,
        fork_block = ?req.fork_block,
        "preflight: starting fork simulation"
    );
    match simulator.run(req).await {
        Ok(result) => {
            tracing::info!(
                pass = result.pass,
                gas = result.gas_estimate,
                reason = ?result.reason,
                "preflight: completed"
            );
            Ok(Json(result.into()))
        }
        Err(err) => {
            tracing::warn!(error = %err, "preflight: simulation failed");
            // Distinguish infrastructure failures (503) from client errors (400).
            let status = match err {
                trading_runtime::TradingError::SimulationUnavailable(_) => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
                trading_runtime::TradingError::Timeout(_) => StatusCode::GATEWAY_TIMEOUT,
                _ => StatusCode::BAD_GATEWAY,
            };
            Err((status, err.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> PreflightRequestBody {
        PreflightRequestBody {
            chain_id: 1,
            vault: "0x0000000000000000000000000000000000000099".into(),
            target: "0xE592427A0AEce92De3Edee1F18E0157C05861564".into(),
            value: Some("0".into()),
            data: "0xdeadbeef".into(),
            output_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".into(),
            min_output: Some("1000".into()),
            aave: Some(AaveContextBody {
                pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".into(),
                account: "0x0000000000000000000000000000000000000099".into(),
            }),
            fork_block: Some(19_000_000),
        }
    }

    #[test]
    fn body_parses_into_runtime_request() {
        let req = body().into_runtime().unwrap();
        assert_eq!(req.chain_id, 1);
        assert_eq!(req.value, U256::ZERO);
        assert_eq!(req.min_output, U256::from(1000u64));
        assert_eq!(req.data.as_ref(), &[0xde, 0xad, 0xbe, 0xef]);
        assert!(req.aave.is_some());
        assert_eq!(req.fork_block, Some(19_000_000));
    }

    #[test]
    fn body_rejects_bad_address() {
        let mut bad = body();
        bad.vault = "not-an-address".into();
        let err = bad.into_runtime().unwrap_err();
        assert!(err.contains("vault"));
    }

    #[test]
    fn body_rejects_bad_hex() {
        let mut bad = body();
        bad.data = "0xzz".into();
        let err = bad.into_runtime().unwrap_err();
        assert!(err.contains("data"));
    }

    #[test]
    fn body_accepts_decimal_and_hex_u256() {
        let mut req = body();
        req.value = Some("100".into());
        let parsed = req.clone().into_runtime().unwrap();
        assert_eq!(parsed.value, U256::from(100u64));

        req.value = Some("0xff".into());
        let parsed = req.into_runtime().unwrap();
        assert_eq!(parsed.value, U256::from(255u64));
    }

    #[test]
    fn body_defaults_value_and_min_output() {
        let mut req = body();
        req.value = None;
        req.min_output = None;
        let parsed = req.into_runtime().unwrap();
        assert_eq!(parsed.value, U256::ZERO);
        assert_eq!(parsed.min_output, U256::ZERO);
    }

    #[test]
    fn response_round_trip() {
        let runtime = PreflightResult {
            pass: false,
            predicted_output: U256::from(123u64),
            predicted_health_factor: Some(U256::from(2_000_000_000_000_000_000u128)),
            gas_estimate: 12_345,
            reason: Some("OutputBelowMinimum".into()),
            balance_before: U256::ZERO,
            balance_after: U256::from(123u64),
        };
        let body: PreflightResponseBody = runtime.into();
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["pass"], false);
        assert_eq!(json["predicted_output"], "123");
        assert_eq!(json["predicted_health_factor"], "2000000000000000000");
        assert_eq!(json["gas_estimate"], 12_345);
        assert_eq!(json["reason"], "OutputBelowMinimum");
        assert_eq!(json["balance_before"], "0");
        assert_eq!(json["balance_after"], "123");
    }

    #[test]
    fn build_config_prefers_explicit_rpc_when_env_unset() {
        let prev = std::env::var("PREFLIGHT_FORK_RPC_URL").ok();
        // SAFETY: see preflight::tests::config_default_picks_up_env. Tests in
        // this module mutate process env serially via std's default test
        // harness; we snapshot/restore to keep them hermetic.
        unsafe {
            std::env::remove_var("PREFLIGHT_FORK_RPC_URL");
        }
        let cfg = build_preflight_config(Some("http://127.0.0.1:8545"));
        assert_eq!(cfg.fork_rpc_url.as_deref(), Some("http://127.0.0.1:8545"));
        unsafe {
            if let Some(v) = prev {
                std::env::set_var("PREFLIGHT_FORK_RPC_URL", v);
            }
        }
    }
}
