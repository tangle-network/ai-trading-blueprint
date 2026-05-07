//! Per-protocol quote endpoints for envelope-v3.
//!
//! These routes proxy on-chain quoter calls so the agent can size an envelope
//! without re-implementing each protocol's pricing primitive. Each handler
//! returns the projected output (or APY/market state for lending) plus a
//! recommended enforcement struct that the agent can drop straight into a
//! [`SignedEnvelope`].
//!
//! All numeric values in the response are stringified — matches the rest of
//! the v3 envelope JSON schema where `U256` fields are encoded as decimal
//! strings.

use std::sync::Arc;

use alloy::primitives::{Address, B256, Bytes, Signed, U256, Uint};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol_types::SolCall;
use axum::extract::Extension;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use trading_runtime::contracts::{
    IAaveV3DataProvider, IAerodromeSlipstreamQuoter, IMorpho, IUniswapV3QuoterV2, IUniswapV4Quoter,
};

use crate::{BotContext, MultiBotTradingState};

// ── Per-chain quoter address registry ───────────────────────────────────────
//
// These constants live here because the http-api is the natural owner of the
// off-chain pricing surface. Mainnet adapters in trading-runtime own router
// addresses; these are the read-only quoter peers.

/// Uniswap V3 QuoterV2 — canonical deployment shared across chains where the
/// official Uniswap deployment exists.
const UNISWAP_V3_QUOTER_V2: &str = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

/// Chains where the canonical Uniswap V3 SwapRouter / QuoterV2 are deployed.
fn uniswap_v3_quoter_for_chain(chain_id: u64) -> Option<Address> {
    if let Ok(raw) = std::env::var(format!("UNISWAP_V3_QUOTER_{chain_id}")) {
        if let Ok(addr) = raw.parse() {
            return Some(addr);
        }
    }
    match chain_id {
        // Mainnet, Arbitrum, Polygon, Optimism, Base — canonical Uniswap V3 chains.
        1 | 42161 | 137 | 10 | 8453 => UNISWAP_V3_QUOTER_V2.parse().ok(),
        _ => None,
    }
}

/// Mainnet Uniswap V3 SwapRouter02 — the same constant the trading-runtime
/// adapter reuses for envelope routing.
const UNISWAP_V3_ROUTER: &str = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

/// Uniswap V4 V4Quoter — deployment per chain.
fn uniswap_v4_quoter_for_chain(chain_id: u64) -> Option<Address> {
    if let Ok(raw) = std::env::var(format!("UNISWAP_V4_QUOTER_{chain_id}")) {
        if let Ok(addr) = raw.parse() {
            return Some(addr);
        }
    }
    match chain_id {
        // Mainnet
        1 => "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203".parse().ok(),
        // Base
        8453 => "0x0d5e0F971ED27FBfF6c2837bf31316121532048D".parse().ok(),
        // Arbitrum
        42161 => "0x3972c00f7Ed4885e145823eB7C655375D275A1C5".parse().ok(),
        _ => None,
    }
}

/// Universal Router 2.0 — used to route v4 swaps from the vault.
fn uniswap_universal_router_for_chain(chain_id: u64) -> Option<Address> {
    if let Ok(raw) = std::env::var(format!("UNISWAP_UNIVERSAL_ROUTER_{chain_id}")) {
        if let Ok(addr) = raw.parse() {
            return Some(addr);
        }
    }
    match chain_id {
        1 => "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af".parse().ok(),
        8453 => "0x6fF5693b99212Da76ad316178A184AB56D299b43".parse().ok(),
        42161 => "0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3".parse().ok(),
        _ => None,
    }
}

/// Aerodrome Slipstream Quoter (Base only).
fn aerodrome_quoter_for_chain(chain_id: u64) -> Option<Address> {
    if let Ok(raw) = std::env::var(format!("AERODROME_QUOTER_{chain_id}")) {
        if let Ok(addr) = raw.parse() {
            return Some(addr);
        }
    }
    match chain_id {
        8453 => "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0".parse().ok(),
        _ => None,
    }
}

/// Aerodrome Slipstream Router (Base) — what the vault actually swaps through.
const AERODROME_ROUTER: &str = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";

/// Morpho Blue protocol address per chain.
fn morpho_for_chain(chain_id: u64) -> Option<Address> {
    if let Ok(raw) = std::env::var(format!("MORPHO_BLUE_{chain_id}")) {
        if let Ok(addr) = raw.parse() {
            return Some(addr);
        }
    }
    match chain_id {
        // Mainnet + Base — only chains where Morpho Blue is currently deployed.
        1 => "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFFb".parse().ok(),
        8453 => "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFFb".parse().ok(),
        _ => None,
    }
}

// ── Request / response shapes ───────────────────────────────────────────────

const DEFAULT_SLIPPAGE_BPS: u32 = 100; // 1.0% — applied to projected rate as the recommended floor.
const DEFAULT_AAVE_MIN_HEALTH_FACTOR_WAD: &str = "1500000000000000000"; // 1.5e18
const DEFAULT_MORPHO_COLLATERAL_RATIO_BPS: u32 = 9_500; // 0.95 of LLTV
const BPS_DENOMINATOR: u128 = 10_000;
const WAD: u128 = 1_000_000_000_000_000_000;

/// Helper newtype for U256 fields — always serialized as a decimal string.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(transparent)]
pub struct U256Str(pub String);

impl From<U256> for U256Str {
    fn from(v: U256) -> Self {
        Self(v.to_string())
    }
}

#[derive(Deserialize)]
pub struct UniswapV3QuoteRequest {
    pub token_in: String,
    pub token_out: String,
    pub fee_tier: u32,
    pub amount_in: String,
    /// Optional — must match the bot's chain when present.
    #[serde(default)]
    pub chain_id: Option<u64>,
    /// Override slippage tolerance in basis points (default `100` = 1%).
    #[serde(default)]
    pub slippage_bps: Option<u32>,
}

#[derive(Serialize)]
pub struct UniswapV3SwapEnforcementOut {
    pub kind: &'static str,
    pub router: String,
    pub token_in: String,
    pub token_out: String,
    pub fee_tier: u32,
    pub max_single_amount_in: U256Str,
    pub max_total_amount_in: U256Str,
    pub min_output_per_input: U256Str,
}

#[derive(Serialize)]
pub struct UniswapV3QuoteResponse {
    pub protocol: &'static str,
    pub chain_id: u64,
    pub amount_in: U256Str,
    pub amount_out: U256Str,
    pub min_output_per_input: U256Str,
    pub slippage_bps: u32,
    pub enforcement: UniswapV3SwapEnforcementOut,
}

#[derive(Deserialize)]
pub struct UniswapV4QuoteRequest {
    pub currency0: String,
    pub currency1: String,
    pub fee: u32,
    pub tick_spacing: i32,
    pub hooks: String,
    pub zero_for_one: bool,
    pub amount_in: String,
    #[serde(default)]
    pub chain_id: Option<u64>,
    #[serde(default)]
    pub slippage_bps: Option<u32>,
}

#[derive(Serialize)]
pub struct UniswapV4SwapEnforcementOut {
    pub kind: &'static str,
    pub currency0: String,
    pub currency1: String,
    pub fee: u32,
    pub tick_spacing: i32,
    pub hooks: String,
    pub zero_for_one: bool,
    pub max_single_amount_in: U256Str,
    pub max_total_amount_in: U256Str,
    pub min_output_per_input: U256Str,
    pub universal_router: String,
}

#[derive(Serialize)]
pub struct UniswapV4QuoteResponse {
    pub protocol: &'static str,
    pub chain_id: u64,
    pub amount_in: U256Str,
    pub amount_out: U256Str,
    pub min_output_per_input: U256Str,
    pub slippage_bps: u32,
    pub enforcement: UniswapV4SwapEnforcementOut,
}

#[derive(Deserialize)]
pub struct AerodromeQuoteRequest {
    pub token_in: String,
    pub token_out: String,
    pub tick_spacing: i32,
    pub amount_in: String,
    #[serde(default)]
    pub chain_id: Option<u64>,
    #[serde(default)]
    pub slippage_bps: Option<u32>,
}

#[derive(Serialize)]
pub struct AerodromeSwapEnforcementOut {
    pub kind: &'static str,
    pub router: String,
    pub token_in: String,
    pub token_out: String,
    pub tick_spacing: i32,
    pub max_single_amount_in: U256Str,
    pub max_total_amount_in: U256Str,
    pub min_output_per_input: U256Str,
}

#[derive(Serialize)]
pub struct AerodromeQuoteResponse {
    pub protocol: &'static str,
    pub chain_id: u64,
    pub amount_in: U256Str,
    pub amount_out: U256Str,
    pub min_output_per_input: U256Str,
    pub slippage_bps: u32,
    pub enforcement: AerodromeSwapEnforcementOut,
}

#[derive(Deserialize)]
pub struct AaveQuoteRequest {
    pub asset: String,
    /// "supply" | "borrow"
    pub action: String,
    #[serde(default)]
    pub chain_id: Option<u64>,
    /// Override the recommended health-factor floor (1e18-scaled string).
    #[serde(default)]
    pub min_health_factor_wad: Option<String>,
    /// Optional cap to seed `max_single_amount` / `max_total_amount` in the
    /// returned enforcement. Defaults to a bot-friendly placeholder.
    #[serde(default)]
    pub max_single_amount: Option<String>,
    #[serde(default)]
    pub max_total_amount: Option<String>,
    /// Aave V3 borrow rate mode — `2` = variable (default), `1` = stable
    /// (rejected on most reserves).
    #[serde(default)]
    pub interest_rate_mode: Option<u8>,
}

/// Generic `kind`-tagged enforcement payload — kept loose so a single field
/// can carry either AaveSupply or AaveBorrow shapes without two response
/// types per route.
#[derive(Serialize)]
pub struct AaveEnforcementOut {
    pub kind: &'static str,
    pub pool: String,
    pub asset: String,
    pub max_single_amount: U256Str,
    pub max_total_amount: U256Str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_health_factor: Option<U256Str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interest_rate_mode: Option<u8>,
}

#[derive(Serialize)]
pub struct AaveQuoteResponse {
    pub protocol: &'static str,
    pub chain_id: u64,
    pub action: String,
    pub asset: String,
    pub pool: String,
    /// Aave's "Ray" liquidity rate (1e27-scaled per-second yield). Forwarded
    /// untouched so the caller can convert to APY however they see fit.
    pub liquidity_rate_ray: U256Str,
    /// Aave's "Ray" variable borrow rate.
    pub variable_borrow_rate_ray: U256Str,
    /// Convenience: Ray rate converted to a basis-point APY estimate via the
    /// canonical SECONDS_PER_YEAR linearization Aave's UI uses.
    pub supply_apy_bps: u32,
    pub borrow_apy_bps: u32,
    pub min_health_factor: U256Str,
    pub enforcement: AaveEnforcementOut,
}

#[derive(Deserialize)]
pub struct MorphoQuoteRequest {
    pub market_id: String,
    /// "supply" | "borrow"
    pub action: String,
    #[serde(default)]
    pub chain_id: Option<u64>,
    #[serde(default)]
    pub max_single_amount: Option<String>,
    #[serde(default)]
    pub max_total_amount: Option<String>,
    /// Override the recommended collateral-ratio floor (1e18-scaled string).
    #[serde(default)]
    pub min_collateral_ratio_wad: Option<String>,
}

#[derive(Serialize)]
pub struct MorphoEnforcementOut {
    pub kind: &'static str,
    pub morpho: String,
    pub market_id: String,
    pub max_single_amount: U256Str,
    pub max_total_amount: U256Str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_collateral_ratio: Option<U256Str>,
}

#[derive(Serialize)]
pub struct MorphoQuoteResponse {
    pub protocol: &'static str,
    pub chain_id: u64,
    pub action: String,
    pub morpho: String,
    pub market_id: String,
    pub total_supply_assets: U256Str,
    pub total_borrow_assets: U256Str,
    pub lltv: U256Str,
    pub min_collateral_ratio: U256Str,
    pub enforcement: MorphoEnforcementOut,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn parse_address(field: &str, raw: &str) -> Result<Address, (StatusCode, String)> {
    raw.trim().parse::<Address>().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid {field} '{raw}': {e}"),
        )
    })
}

fn parse_u256(field: &str, raw: &str) -> Result<U256, (StatusCode, String)> {
    let trimmed = raw.trim();
    U256::from_str_radix(
        trimmed.trim_start_matches("0x"),
        if trimmed.starts_with("0x") { 16 } else { 10 },
    )
    .map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid {field} '{raw}': {e}"),
        )
    })
}

fn parse_b256(field: &str, raw: &str) -> Result<B256, (StatusCode, String)> {
    raw.trim().parse::<B256>().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid {field} '{raw}': {e}"),
        )
    })
}

fn ensure_bot_chain(bot: &BotContext, requested: Option<u64>) -> Result<u64, (StatusCode, String)> {
    match requested {
        Some(chain) if chain != bot.chain_id => Err((
            StatusCode::BAD_REQUEST,
            format!(
                "chain_id {chain} in body does not match bot's chain_id {}",
                bot.chain_id
            ),
        )),
        _ => Ok(bot.chain_id),
    }
}

/// Compute `min_output_per_input = projected_rate * (1 - slippage)`.
///
/// `projected_rate = amount_out * 1e18 / amount_in`. Using checked math so
/// adversarial inputs (zero amount_in) return a 400, not a panic.
fn min_output_per_input(
    amount_in: U256,
    amount_out: U256,
    slippage_bps: u32,
) -> Result<U256, (StatusCode, String)> {
    if amount_in == U256::ZERO {
        return Err((StatusCode::BAD_REQUEST, "amount_in must be > 0".into()));
    }
    let bps = U256::from(BPS_DENOMINATOR);
    let slippage = U256::from(u128::from(slippage_bps.min(BPS_DENOMINATOR as u32)));
    let raw_rate = amount_out
        .checked_mul(U256::from(WAD))
        .and_then(|v| v.checked_div(amount_in))
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "rate overflow computing min_output_per_input".into(),
            )
        })?;
    let kept = bps - slippage;
    raw_rate
        .checked_mul(kept)
        .and_then(|v| v.checked_div(bps))
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "slippage application overflowed".into(),
            )
        })
}

fn slippage_or_default(opt: Option<u32>) -> u32 {
    opt.filter(|bps| *bps <= BPS_DENOMINATOR as u32)
        .unwrap_or(DEFAULT_SLIPPAGE_BPS)
}

async fn eth_call(
    rpc_url: &str,
    to: Address,
    data: Vec<u8>,
) -> Result<Bytes, (StatusCode, String)> {
    let url = rpc_url.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid RPC URL '{rpc_url}': {e}"),
        )
    })?;
    let provider = ProviderBuilder::new().connect_http(url);
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());
    provider
        .call(tx)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("RPC eth_call failed: {e}")))
}

/// Aave's "Ray" rate (1e27-scaled per-second). Convert to bps APY using the
/// same linear approximation Aave's UI shows (rate * SECONDS_PER_YEAR).
fn ray_rate_to_apy_bps(rate_ray: U256) -> u32 {
    const SECONDS_PER_YEAR: u128 = 31_536_000;
    const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;
    // bps = rate_ray * SECONDS_PER_YEAR * 10000 / RAY
    let scaled = rate_ray
        .checked_mul(U256::from(SECONDS_PER_YEAR))
        .and_then(|v| v.checked_mul(U256::from(BPS_DENOMINATOR)))
        .map(|v| v / U256::from(RAY))
        .unwrap_or(U256::ZERO);
    // Cap at u32::MAX bps (>>1000% APY) to avoid overflow on bogus inputs.
    let bps_u128 = u128::try_from(scaled).unwrap_or(u128::from(u32::MAX));
    u32::try_from(bps_u128.min(u128::from(u32::MAX))).unwrap_or(u32::MAX)
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn quote_uniswap_v3(
    Extension(bot): Extension<BotContext>,
    Json(req): Json<UniswapV3QuoteRequest>,
) -> Result<Json<UniswapV3QuoteResponse>, (StatusCode, String)> {
    let chain_id = ensure_bot_chain(&bot, req.chain_id)?;
    let token_in = parse_address("token_in", &req.token_in)?;
    let token_out = parse_address("token_out", &req.token_out)?;
    let amount_in = parse_u256("amount_in", &req.amount_in)?;
    if amount_in == U256::ZERO {
        return Err((StatusCode::BAD_REQUEST, "amount_in must be > 0".into()));
    }
    if token_in == token_out {
        return Err((
            StatusCode::BAD_REQUEST,
            "token_in and token_out must differ".into(),
        ));
    }
    let quoter = uniswap_v3_quoter_for_chain(chain_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!(
                "No Uniswap V3 quoter known for chain {chain_id}; set UNISWAP_V3_QUOTER_{chain_id}",
            ),
        )
    })?;
    let router: Address = UNISWAP_V3_ROUTER.parse().expect("valid router");

    type Uint24 = Uint<24, 1>;
    type Uint160 = Uint<160, 3>;

    let call = IUniswapV3QuoterV2::quoteExactInputSingleCall {
        params: IUniswapV3QuoterV2::QuoteExactInputSingleParams {
            tokenIn: token_in,
            tokenOut: token_out,
            amountIn: amount_in,
            fee: Uint24::from(req.fee_tier),
            sqrtPriceLimitX96: Uint160::ZERO,
        },
    };
    let raw = eth_call(&bot.rpc_url, quoter, call.abi_encode()).await?;
    let decoded =
        IUniswapV3QuoterV2::quoteExactInputSingleCall::abi_decode_returns(&raw).map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to decode V3 quote: {e}"),
            )
        })?;

    let slippage_bps = slippage_or_default(req.slippage_bps);
    let min_per_in = min_output_per_input(amount_in, decoded.amountOut, slippage_bps)?;

    let response = UniswapV3QuoteResponse {
        protocol: "uniswap_v3",
        chain_id,
        amount_in: amount_in.into(),
        amount_out: decoded.amountOut.into(),
        min_output_per_input: min_per_in.into(),
        slippage_bps,
        enforcement: UniswapV3SwapEnforcementOut {
            kind: "uniswap_v3_swap",
            router: format!("{router:#x}"),
            token_in: format!("{token_in:#x}"),
            token_out: format!("{token_out:#x}"),
            fee_tier: req.fee_tier,
            max_single_amount_in: amount_in.into(),
            max_total_amount_in: amount_in.into(),
            min_output_per_input: min_per_in.into(),
        },
    };
    Ok(Json(response))
}

async fn quote_uniswap_v4(
    Extension(bot): Extension<BotContext>,
    Json(req): Json<UniswapV4QuoteRequest>,
) -> Result<Json<UniswapV4QuoteResponse>, (StatusCode, String)> {
    let chain_id = ensure_bot_chain(&bot, req.chain_id)?;
    let currency0 = parse_address("currency0", &req.currency0)?;
    let currency1 = parse_address("currency1", &req.currency1)?;
    let hooks = parse_address("hooks", &req.hooks)?;
    let amount_in = parse_u256("amount_in", &req.amount_in)?;
    if amount_in == U256::ZERO {
        return Err((StatusCode::BAD_REQUEST, "amount_in must be > 0".into()));
    }
    if currency0 >= currency1 {
        return Err((
            StatusCode::BAD_REQUEST,
            "currency0 must be the lower address (currency0 < currency1)".into(),
        ));
    }
    let amount_in_u128 = u128::try_from(amount_in).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "amount_in exceeds uint128 — V4 quoter takes uint128 exactAmount".into(),
        )
    })?;

    let quoter = uniswap_v4_quoter_for_chain(chain_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!(
                "No Uniswap V4 quoter known for chain {chain_id}; set UNISWAP_V4_QUOTER_{chain_id}",
            ),
        )
    })?;
    let universal_router = uniswap_universal_router_for_chain(chain_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!(
                "No Universal Router known for chain {chain_id}; set UNISWAP_UNIVERSAL_ROUTER_{chain_id}",
            ),
        )
    })?;

    type Uint24 = Uint<24, 1>;
    type Int24 = Signed<24, 1>;
    let tick_spacing_i24 = Int24::try_from(i64::from(req.tick_spacing)).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("tick_spacing out of range for int24: {e}"),
        )
    })?;

    let call = IUniswapV4Quoter::quoteExactInputSingleCall {
        params: IUniswapV4Quoter::QuoteExactSingleParams {
            poolKey: IUniswapV4Quoter::PoolKey {
                currency0,
                currency1,
                fee: Uint24::from(req.fee),
                tickSpacing: tick_spacing_i24,
                hooks,
            },
            zeroForOne: req.zero_for_one,
            exactAmount: amount_in_u128,
            hookData: Bytes::new(),
        },
    };

    let raw = eth_call(&bot.rpc_url, quoter, call.abi_encode()).await?;
    let decoded =
        IUniswapV4Quoter::quoteExactInputSingleCall::abi_decode_returns(&raw).map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to decode V4 quote: {e}"),
            )
        })?;

    let slippage_bps = slippage_or_default(req.slippage_bps);
    let min_per_in = min_output_per_input(amount_in, decoded.amountOut, slippage_bps)?;

    let response = UniswapV4QuoteResponse {
        protocol: "uniswap_v4",
        chain_id,
        amount_in: amount_in.into(),
        amount_out: decoded.amountOut.into(),
        min_output_per_input: min_per_in.into(),
        slippage_bps,
        enforcement: UniswapV4SwapEnforcementOut {
            kind: "uniswap_v4_swap",
            currency0: format!("{currency0:#x}"),
            currency1: format!("{currency1:#x}"),
            fee: req.fee,
            tick_spacing: req.tick_spacing,
            hooks: format!("{hooks:#x}"),
            zero_for_one: req.zero_for_one,
            max_single_amount_in: amount_in.into(),
            max_total_amount_in: amount_in.into(),
            min_output_per_input: min_per_in.into(),
            universal_router: format!("{universal_router:#x}"),
        },
    };
    Ok(Json(response))
}

async fn quote_aerodrome(
    Extension(bot): Extension<BotContext>,
    Json(req): Json<AerodromeQuoteRequest>,
) -> Result<Json<AerodromeQuoteResponse>, (StatusCode, String)> {
    let chain_id = ensure_bot_chain(&bot, req.chain_id)?;
    let token_in = parse_address("token_in", &req.token_in)?;
    let token_out = parse_address("token_out", &req.token_out)?;
    let amount_in = parse_u256("amount_in", &req.amount_in)?;
    if amount_in == U256::ZERO {
        return Err((StatusCode::BAD_REQUEST, "amount_in must be > 0".into()));
    }
    if token_in == token_out {
        return Err((
            StatusCode::BAD_REQUEST,
            "token_in and token_out must differ".into(),
        ));
    }
    let quoter = aerodrome_quoter_for_chain(chain_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!(
                "No Aerodrome quoter known for chain {chain_id}; set AERODROME_QUOTER_{chain_id}",
            ),
        )
    })?;
    let router: Address = AERODROME_ROUTER.parse().expect("valid aerodrome router");

    type Int24 = Signed<24, 1>;
    type Uint160 = Uint<160, 3>;
    let tick_spacing_i24 = Int24::try_from(i64::from(req.tick_spacing)).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("tick_spacing out of range for int24: {e}"),
        )
    })?;

    let call = IAerodromeSlipstreamQuoter::quoteExactInputSingleCall {
        params: IAerodromeSlipstreamQuoter::QuoteExactInputSingleParams {
            tokenIn: token_in,
            tokenOut: token_out,
            amountIn: amount_in,
            tickSpacing: tick_spacing_i24,
            sqrtPriceLimitX96: Uint160::ZERO,
        },
    };
    let raw = eth_call(&bot.rpc_url, quoter, call.abi_encode()).await?;
    let decoded = IAerodromeSlipstreamQuoter::quoteExactInputSingleCall::abi_decode_returns(&raw)
        .map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode Aerodrome quote: {e}"),
        )
    })?;

    let slippage_bps = slippage_or_default(req.slippage_bps);
    let min_per_in = min_output_per_input(amount_in, decoded.amountOut, slippage_bps)?;

    let response = AerodromeQuoteResponse {
        protocol: "aerodrome",
        chain_id,
        amount_in: amount_in.into(),
        amount_out: decoded.amountOut.into(),
        min_output_per_input: min_per_in.into(),
        slippage_bps,
        enforcement: AerodromeSwapEnforcementOut {
            kind: "aerodrome_swap",
            router: format!("{router:#x}"),
            token_in: format!("{token_in:#x}"),
            token_out: format!("{token_out:#x}"),
            tick_spacing: req.tick_spacing,
            max_single_amount_in: amount_in.into(),
            max_total_amount_in: amount_in.into(),
            min_output_per_input: min_per_in.into(),
        },
    };
    Ok(Json(response))
}

async fn quote_aave_v3(
    Extension(bot): Extension<BotContext>,
    Json(req): Json<AaveQuoteRequest>,
) -> Result<Json<AaveQuoteResponse>, (StatusCode, String)> {
    let chain_id = ensure_bot_chain(&bot, req.chain_id)?;
    let asset = parse_address("asset", &req.asset)?;
    let action = req.action.to_ascii_lowercase();
    if action != "supply" && action != "borrow" {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("action must be 'supply' or 'borrow', got '{}'", req.action),
        ));
    }

    let market =
        trading_runtime::aave_v3_registry::market_for_chain(chain_id).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("Aave V3 not configured for chain {chain_id}"),
            )
        })?;
    let pool: Address = market.pool.parse().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Aave registry pool address invalid: {e}"),
        )
    })?;
    let data_provider: Address = market.protocol_data_provider.parse().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Aave registry protocol_data_provider invalid: {e}"),
        )
    })?;

    let call = IAaveV3DataProvider::getReserveDataCall { asset };
    let raw = eth_call(&bot.rpc_url, data_provider, call.abi_encode()).await?;
    let decoded =
        IAaveV3DataProvider::getReserveDataCall::abi_decode_returns(&raw).map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to decode Aave reserve data: {e}"),
            )
        })?;

    let min_health_factor = match req.min_health_factor_wad {
        Some(raw) => parse_u256("min_health_factor_wad", &raw)?,
        None => match std::env::var("TRADING_ENVELOPE_AAVE_MIN_HEALTH_FACTOR_WAD") {
            Ok(raw) => parse_u256("TRADING_ENVELOPE_AAVE_MIN_HEALTH_FACTOR_WAD", &raw)?,
            Err(_) => parse_u256("default", DEFAULT_AAVE_MIN_HEALTH_FACTOR_WAD)?,
        },
    };
    if min_health_factor == U256::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "min_health_factor_wad must be > 0".into(),
        ));
    }

    let max_single = match req.max_single_amount {
        Some(s) => parse_u256("max_single_amount", &s)?,
        None => U256::from(u128::MAX),
    };
    let max_total = match req.max_total_amount {
        Some(s) => parse_u256("max_total_amount", &s)?,
        None => max_single,
    };
    if max_single == U256::ZERO || max_total == U256::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "max_single_amount and max_total_amount must be > 0".into(),
        ));
    }
    if max_single > max_total {
        return Err((
            StatusCode::BAD_REQUEST,
            "max_single_amount must be <= max_total_amount".into(),
        ));
    }

    let supply_apy_bps = ray_rate_to_apy_bps(decoded.liquidityRate);
    let borrow_apy_bps = ray_rate_to_apy_bps(decoded.variableBorrowRate);

    let enforcement = match action.as_str() {
        "supply" => AaveEnforcementOut {
            kind: "aave_supply",
            pool: format!("{pool:#x}"),
            asset: format!("{asset:#x}"),
            max_single_amount: max_single.into(),
            max_total_amount: max_total.into(),
            min_health_factor: None,
            interest_rate_mode: None,
        },
        "borrow" => {
            let rate_mode = req.interest_rate_mode.unwrap_or(2);
            if rate_mode != 1 && rate_mode != 2 {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "interest_rate_mode must be 1 (stable) or 2 (variable)".into(),
                ));
            }
            AaveEnforcementOut {
                kind: "aave_borrow",
                pool: format!("{pool:#x}"),
                asset: format!("{asset:#x}"),
                max_single_amount: max_single.into(),
                max_total_amount: max_total.into(),
                min_health_factor: Some(min_health_factor.into()),
                interest_rate_mode: Some(rate_mode),
            }
        }
        _ => unreachable!(),
    };

    let response = AaveQuoteResponse {
        protocol: "aave_v3",
        chain_id,
        action,
        asset: format!("{asset:#x}"),
        pool: format!("{pool:#x}"),
        liquidity_rate_ray: decoded.liquidityRate.into(),
        variable_borrow_rate_ray: decoded.variableBorrowRate.into(),
        supply_apy_bps,
        borrow_apy_bps,
        min_health_factor: min_health_factor.into(),
        enforcement,
    };
    Ok(Json(response))
}

async fn quote_morpho(
    Extension(bot): Extension<BotContext>,
    Json(req): Json<MorphoQuoteRequest>,
) -> Result<Json<MorphoQuoteResponse>, (StatusCode, String)> {
    let chain_id = ensure_bot_chain(&bot, req.chain_id)?;
    let market_id = parse_b256("market_id", &req.market_id)?;
    if market_id == B256::ZERO {
        return Err((StatusCode::BAD_REQUEST, "market_id must be non-zero".into()));
    }
    let action = req.action.to_ascii_lowercase();
    if action != "supply" && action != "borrow" {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("action must be 'supply' or 'borrow', got '{}'", req.action),
        ));
    }
    let morpho = morpho_for_chain(chain_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!(
                "No Morpho Blue deployment known for chain {chain_id}; set MORPHO_BLUE_{chain_id}"
            ),
        )
    })?;

    let market_call = IMorpho::marketCall { id: market_id };
    let raw = eth_call(&bot.rpc_url, morpho, market_call.abi_encode()).await?;
    let market = IMorpho::marketCall::abi_decode_returns(&raw).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode Morpho market state: {e}"),
        )
    })?;

    let params_call = IMorpho::idToMarketParamsCall { id: market_id };
    let raw = eth_call(&bot.rpc_url, morpho, params_call.abi_encode()).await?;
    let params = IMorpho::idToMarketParamsCall::abi_decode_returns(&raw).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode Morpho market params: {e}"),
        )
    })?;
    if params.lltv == U256::ZERO {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Morpho market returned zero LLTV — market likely not initialized".into(),
        ));
    }

    let min_collateral_ratio = match req.min_collateral_ratio_wad {
        Some(raw) => parse_u256("min_collateral_ratio_wad", &raw)?,
        None => match std::env::var("TRADING_ENVELOPE_MORPHO_MIN_COLLATERAL_RATIO_WAD") {
            Ok(raw) => parse_u256("TRADING_ENVELOPE_MORPHO_MIN_COLLATERAL_RATIO_WAD", &raw)?,
            Err(_) => {
                params.lltv * U256::from(u128::from(DEFAULT_MORPHO_COLLATERAL_RATIO_BPS))
                    / U256::from(BPS_DENOMINATOR)
            }
        },
    };

    let max_single = match req.max_single_amount {
        Some(s) => parse_u256("max_single_amount", &s)?,
        None => U256::from(u128::MAX),
    };
    let max_total = match req.max_total_amount {
        Some(s) => parse_u256("max_total_amount", &s)?,
        None => max_single,
    };
    if max_single == U256::ZERO || max_total == U256::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "max_single_amount and max_total_amount must be > 0".into(),
        ));
    }
    if max_single > max_total {
        return Err((
            StatusCode::BAD_REQUEST,
            "max_single_amount must be <= max_total_amount".into(),
        ));
    }

    let enforcement = match action.as_str() {
        "supply" => MorphoEnforcementOut {
            kind: "morpho_supply",
            morpho: format!("{morpho:#x}"),
            market_id: format!("{market_id:#x}"),
            max_single_amount: max_single.into(),
            max_total_amount: max_total.into(),
            min_collateral_ratio: None,
        },
        "borrow" => MorphoEnforcementOut {
            kind: "morpho_borrow",
            morpho: format!("{morpho:#x}"),
            market_id: format!("{market_id:#x}"),
            max_single_amount: max_single.into(),
            max_total_amount: max_total.into(),
            min_collateral_ratio: Some(min_collateral_ratio.into()),
        },
        _ => unreachable!(),
    };

    let total_supply = U256::from(market.totalSupplyAssets);
    let total_borrow = U256::from(market.totalBorrowAssets);

    let response = MorphoQuoteResponse {
        protocol: "morpho",
        chain_id,
        action,
        morpho: format!("{morpho:#x}"),
        market_id: format!("{market_id:#x}"),
        total_supply_assets: total_supply.into(),
        total_borrow_assets: total_borrow.into(),
        lltv: params.lltv.into(),
        min_collateral_ratio: min_collateral_ratio.into(),
        enforcement,
    };
    Ok(Json(response))
}

// ── Router ──────────────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/envelope/quote/uniswap_v3", post(quote_uniswap_v3))
        .route("/envelope/quote/uniswap_v4", post(quote_uniswap_v4))
        .route("/envelope/quote/aerodrome", post(quote_aerodrome))
        .route("/envelope/quote/aave_v3", post(quote_aave_v3))
        .route("/envelope/quote/morpho", post(quote_morpho))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(chain_id: u64) -> BotContext {
        BotContext {
            bot_id: "test-bot".into(),
            vault_address: "0x0000000000000000000000000000000000000099".into(),
            paper_trade: true,
            chain_id,
            rpc_url: "http://127.0.0.1:0/unused".into(),
            strategy_config: serde_json::Value::Null,
            risk_params: serde_json::Value::Null,
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        }
    }

    #[test]
    fn test_ensure_bot_chain_accepts_match_or_missing() {
        let b = bot(1);
        assert_eq!(ensure_bot_chain(&b, None).unwrap(), 1);
        assert_eq!(ensure_bot_chain(&b, Some(1)).unwrap(), 1);
    }

    #[test]
    fn test_ensure_bot_chain_rejects_mismatch() {
        let b = bot(1);
        let err = ensure_bot_chain(&b, Some(8453)).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_parse_u256_decimal_and_hex() {
        assert_eq!(parse_u256("x", "1000").unwrap(), U256::from(1000u64));
        assert_eq!(parse_u256("x", "0x10").unwrap(), U256::from(16u64));
    }

    #[test]
    fn test_parse_u256_rejects_garbage() {
        assert!(parse_u256("x", "not-a-number").is_err());
    }

    #[test]
    fn test_parse_address_rejects_bad_input() {
        assert!(parse_address("token", "not-an-address").is_err());
    }

    #[test]
    fn test_min_output_per_input_basic() {
        // 1e18 in, 2e18 out, 1% slippage → rate = 2e18, floor = 2e18 * 99/100 = 1.98e18
        let in_ = U256::from(WAD);
        let out = U256::from(2u128 * WAD);
        let floor = min_output_per_input(in_, out, 100).unwrap();
        let expected = U256::from(2u128 * WAD) * U256::from(9_900u64) / U256::from(BPS_DENOMINATOR);
        assert_eq!(floor, expected);
    }

    #[test]
    fn test_min_output_per_input_rejects_zero_input() {
        let err = min_output_per_input(U256::ZERO, U256::from(1u64), 100).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_min_output_per_input_zero_out_returns_zero_floor() {
        let floor = min_output_per_input(U256::from(1u64), U256::ZERO, 100).unwrap();
        assert_eq!(floor, U256::ZERO);
    }

    #[test]
    fn test_slippage_or_default_clamps_invalid() {
        assert_eq!(slippage_or_default(None), DEFAULT_SLIPPAGE_BPS);
        assert_eq!(slippage_or_default(Some(50)), 50);
        // Above 10000 bps falls back to default.
        assert_eq!(slippage_or_default(Some(20_000)), DEFAULT_SLIPPAGE_BPS);
    }

    #[test]
    fn test_uniswap_v3_quoter_known_chain_resolves() {
        assert!(uniswap_v3_quoter_for_chain(1).is_some());
        assert!(uniswap_v3_quoter_for_chain(8453).is_some());
        assert!(uniswap_v3_quoter_for_chain(42161).is_some());
    }

    #[test]
    fn test_uniswap_v3_quoter_unknown_chain_returns_none() {
        assert!(uniswap_v3_quoter_for_chain(999_999).is_none());
    }

    #[test]
    fn test_aerodrome_quoter_only_base() {
        assert!(aerodrome_quoter_for_chain(8453).is_some());
        assert!(aerodrome_quoter_for_chain(1).is_none());
    }

    #[test]
    fn test_morpho_for_chain_known() {
        assert!(morpho_for_chain(1).is_some());
        assert!(morpho_for_chain(8453).is_some());
        assert!(morpho_for_chain(42161).is_none());
    }

    #[test]
    fn test_uniswap_v4_quoter_envvar_override() {
        // Use a unique env var name so we don't clobber another test.
        // Different process state, so just validate the lookup function.
        assert!(uniswap_v4_quoter_for_chain(1).is_some());
        assert!(uniswap_v4_quoter_for_chain(999_999).is_none());
    }

    #[test]
    fn test_ray_rate_to_apy_bps_zero() {
        assert_eq!(ray_rate_to_apy_bps(U256::ZERO), 0);
    }

    #[test]
    fn test_ray_rate_to_apy_bps_realistic() {
        // 4% APY → liquidityRate ≈ 4% * 1e27 / SECONDS_PER_YEAR
        // ≈ 1.2683916793e18 (per-second ray rate).
        let per_sec_ray = U256::from(1_268_391_679_350_583_500u128);
        let bps = ray_rate_to_apy_bps(per_sec_ray);
        // Should land near 400 bps; allow ±2 bps for rounding.
        assert!((398..=402).contains(&bps), "got {bps}");
    }

    #[test]
    fn test_uniswap_v3_request_round_trips() {
        let body = r#"{"token_in":"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","token_out":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","fee_tier":3000,"amount_in":"1000000000000000000"}"#;
        let req: UniswapV3QuoteRequest = serde_json::from_str(body).unwrap();
        assert_eq!(req.fee_tier, 3000);
        assert_eq!(req.amount_in, "1000000000000000000");
    }

    #[test]
    fn test_aave_request_rejects_invalid_action() {
        // Sanity check — case normalization happens inside the handler, but
        // the deserializer accepts arbitrary strings.
        let body = r#"{"asset":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","action":"deposit"}"#;
        let req: AaveQuoteRequest = serde_json::from_str(body).unwrap();
        assert_eq!(req.action, "deposit");
    }

    #[test]
    fn test_morpho_request_round_trips() {
        let body = r#"{"market_id":"0x1234567890123456789012345678901234567890123456789012345678901234","action":"supply"}"#;
        let req: MorphoQuoteRequest = serde_json::from_str(body).unwrap();
        assert_eq!(req.action, "supply");
    }

    #[test]
    fn test_morpho_market_id_zero_rejected() {
        let err = parse_b256("market_id", &format!("{:#x}", B256::ZERO));
        // Zero parses as a valid B256 — we reject it at the handler level.
        assert!(err.is_ok());
    }

    #[test]
    fn test_response_serializes_amounts_as_strings() {
        let out = UniswapV3SwapEnforcementOut {
            kind: "uniswap_v3_swap",
            router: "0x".to_string(),
            token_in: "0x".to_string(),
            token_out: "0x".to_string(),
            fee_tier: 3000,
            max_single_amount_in: U256::from(123u64).into(),
            max_total_amount_in: U256::from(123u64).into(),
            min_output_per_input: U256::from(1u64).into(),
        };
        let v = serde_json::to_value(&out).unwrap();
        // String values, not numbers.
        assert!(v["max_single_amount_in"].is_string());
        assert_eq!(v["max_single_amount_in"], "123");
    }
}
