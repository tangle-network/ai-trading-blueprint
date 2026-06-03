use std::str::FromStr;

use alloy::primitives::Address;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::warn;

use crate::aave_v3_registry::market_for_chain;
use crate::token_metadata::token_metadata_for_chain;

/// Per-entry parse error. Surfaces the reason an entry was rejected so
/// operators see misconfigs in logs (and a future Prometheus counter can
/// tag them by `kind`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupportedAssetParseError {
    MissingAddress,
    InvalidAddress(String),
    StrategyMismatch { expected: String, actual: String },
    ProtocolMismatch { expected: String, actual: String },
    ChainIdMismatch { expected: u64, actual: u64 },
    UnknownValuationAdapter(String),
}

/// Why an asset was refused by the declared-universe gate. Each variant maps
/// to a stable wire code (see [`UnsupportedAssetReason::code`]) so an operator,
/// the validator, and the decision log all read the same machine-parsable
/// reason instead of a free-text "not supported" string that downstream code
/// either ignores or misreads as a transient adapter failure.
///
/// G6 invariant: an asset outside the declared universe MUST surface a typed
/// refusal — never a silent skip and never an empty `Vec`/`None` that a caller
/// can mistake for "no opinion".
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedAssetReason {
    /// The token address/symbol is not in the strategy's declared universe at
    /// all (the common case: an LLM-proposed token nobody allow-listed).
    OutOfUniverse,
    /// The strategy/protocol pair maps to no asset universe whatsoever, so
    /// every asset is implicitly rejected (e.g. `("dex","sushiswap")`).
    UnknownUniverse,
    /// Token exists in the universe but for a different chain id.
    ChainMismatch,
    /// Token exists in the universe but under a different protocol.
    ProtocolMismatch,
    /// Token exists in the universe but is not permitted in the requested role
    /// (e.g. a debt-only aToken used as a swap input).
    RoleMismatch,
}

impl UnsupportedAssetReason {
    /// Stable wire code. Kept distinct from the enum's serde repr so renaming a
    /// Rust variant can never silently change the on-the-wire contract.
    pub fn code(self) -> &'static str {
        match self {
            UnsupportedAssetReason::OutOfUniverse => "out_of_universe",
            UnsupportedAssetReason::UnknownUniverse => "unknown_universe",
            UnsupportedAssetReason::ChainMismatch => "chain_mismatch",
            UnsupportedAssetReason::ProtocolMismatch => "protocol_mismatch",
            UnsupportedAssetReason::RoleMismatch => "role_mismatch",
        }
    }
}

/// Structured refusal emitted when the declared-universe gate rejects an asset.
///
/// Serializes to the canonical refusal envelope so callers (executor, validator,
/// decision log) can pattern-match on `refusal == "asset_not_in_universe"`
/// rather than scraping an error string:
///
/// ```json
/// {"refusal":"asset_not_in_universe","reason":"role_mismatch",
///  "asset":"0x…","role":"input","strategy_type":"dex",
///  "protocol":"uniswap_v3","chain_id":8453}
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetRefusal {
    /// Constant discriminator — always `"asset_not_in_universe"`. Lets a caller
    /// branch on the refusal kind without parsing the message.
    pub refusal: &'static str,
    pub reason: UnsupportedAssetReason,
    /// The token as the caller supplied it (address or symbol), preserved
    /// verbatim for log/forensic correlation.
    pub asset: String,
    pub role: TradeAssetRole,
    pub strategy_type: String,
    pub protocol: String,
    pub chain_id: u64,
}

impl AssetRefusal {
    pub const REFUSAL: &'static str = "asset_not_in_universe";

    pub fn new(
        reason: UnsupportedAssetReason,
        asset: &str,
        role: TradeAssetRole,
        strategy_type: &str,
        protocol: &str,
        chain_id: u64,
    ) -> Self {
        AssetRefusal {
            refusal: Self::REFUSAL,
            reason,
            asset: asset.to_string(),
            role,
            strategy_type: normalize_strategy_type(strategy_type),
            protocol: normalize_protocol(protocol),
            chain_id,
        }
    }

    /// Compact single-line JSON for embedding in an error message / decision
    /// log. Infallible: the shape is closed and always serializes.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            format!(
                "{{\"refusal\":\"{}\",\"reason\":\"{}\",\"asset\":\"{}\"}}",
                Self::REFUSAL,
                self.reason.code(),
                self.asset
            )
        })
    }
}

impl std::fmt::Display for AssetRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_json())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TradeAssetRole {
    Input,
    Output,
    Collateral,
    Wrapper,
    Debt,
}

impl TradeAssetRole {
    /// All roles, used by the declared-universe gate to detect a role-mismatch
    /// (token is in the universe but not permitted in the requested role).
    pub fn all() -> [TradeAssetRole; 5] {
        [
            TradeAssetRole::Input,
            TradeAssetRole::Output,
            TradeAssetRole::Collateral,
            TradeAssetRole::Wrapper,
            TradeAssetRole::Debt,
        ]
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ValuationAdapterKind {
    None,
    ChainlinkUsd,
    ChainlinkOrUniswapV3Twap,
    UniswapV3Twap,
    WrappedAsset,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SupportedAsset {
    pub strategy_type: String,
    pub protocol: String,
    pub chain_id: u64,
    pub symbol: String,
    pub address: String,
    pub decimals: u8,
    pub roles: Vec<TradeAssetRole>,
    pub valuation_adapter: ValuationAdapterKind,
}

pub fn supported_assets_for(
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
) -> Vec<SupportedAsset> {
    let normalized_strategy = normalize_strategy_type(strategy_type);
    let normalized_protocol = normalize_protocol(protocol);
    let registry_chain_id = registry_chain_id(chain_id);

    match (normalized_strategy.as_str(), normalized_protocol.as_str()) {
        // dex (directional), mm (market-making) and multi (portfolio) are all
        // DEX-family strategies that trade the same WETH/USDC spot universe on
        // Uniswap/Aerodrome. Gate them together so an MM/multi bot's swaps
        // aren't rejected as "not in the configured asset universe".
        ("dex" | "mm" | "multi", "uniswap_v3" | "aerodrome") => {
            dex_assets(registry_chain_id, &normalized_protocol)
        }
        ("yield", "aave_v3") => aave_assets(registry_chain_id, &normalized_protocol),
        ("hyperliquid_perp", "hyperliquid") => {
            hyperliquid_perp_assets(registry_chain_id, &normalized_protocol)
        }
        _ => Vec::new(),
    }
}

pub fn supported_assets_for_config(
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
    strategy_config: Option<&Value>,
) -> Vec<SupportedAsset> {
    let normalized_strategy = normalize_strategy_type(strategy_type);
    let normalized_protocol = normalize_protocol(protocol);

    if let Some(configured) = strategy_config.and_then(|config| {
        configured_assets_from_value(config, &normalized_strategy, chain_id, &normalized_protocol)
    }) {
        return configured;
    }

    if normalized_strategy == "hyperliquid_perp"
        && normalized_protocol == "hyperliquid"
        && let Some(asset) =
            hyperliquid_perp_asset_from_config(chain_id, &normalized_protocol, strategy_config)
    {
        return vec![asset];
    }

    supported_assets_for(&normalized_strategy, chain_id, &normalized_protocol)
}

pub fn is_supported_trade_asset(
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
    token: &str,
    role: TradeAssetRole,
) -> Option<SupportedAsset> {
    is_supported_trade_asset_for_config(strategy_type, chain_id, protocol, token, role, None)
}

pub fn is_supported_trade_asset_for_config(
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
    token: &str,
    role: TradeAssetRole,
    strategy_config: Option<&Value>,
) -> Option<SupportedAsset> {
    let key = normalize_token(token);
    let resolved_address = token_metadata_for_chain(Some(chain_id), token)
        .map(|metadata| normalize_token(metadata.address));
    supported_assets_for_config(strategy_type, chain_id, protocol, strategy_config)
        .into_iter()
        .find(|asset| {
            ((normalize_token(&asset.address) == key || normalize_token(&asset.symbol) == key)
                || resolved_address
                    .as_deref()
                    .is_some_and(|address| normalize_token(&asset.address) == address))
                && asset.roles.contains(&role)
        })
}

/// Declared-universe gate (G6).
///
/// Returns the matched [`SupportedAsset`] when `token` is in the strategy's
/// declared universe for `role`, otherwise a typed [`AssetRefusal`] that names
/// *why* it was rejected. This is the hard gate: callers MUST treat `Err` as a
/// refusal to act, not as "no assets configured, proceed".
///
/// Reason classification (most-specific-wins) is derived by re-probing the
/// universe with relaxed predicates so an operator can tell "you typed a token
/// nobody allow-listed" (`OutOfUniverse`) apart from "that token is valid but
/// you used it in the wrong role / on the wrong chain / under the wrong
/// protocol". Distinguishing these is the whole point of G6 — a silent `None`
/// collapsed all four into "nothing happened".
pub fn gate_trade_asset(
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
    token: &str,
    role: TradeAssetRole,
) -> Result<SupportedAsset, AssetRefusal> {
    gate_trade_asset_for_config(strategy_type, chain_id, protocol, token, role, None)
}

/// Config-aware variant of [`gate_trade_asset`]. Honors a per-bot
/// `strategy_config` asset universe override before falling back to the default
/// registry.
pub fn gate_trade_asset_for_config(
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
    token: &str,
    role: TradeAssetRole,
    strategy_config: Option<&Value>,
) -> Result<SupportedAsset, AssetRefusal> {
    if let Some(asset) = is_supported_trade_asset_for_config(
        strategy_type,
        chain_id,
        protocol,
        token,
        role,
        strategy_config,
    ) {
        return Ok(asset);
    }

    let refuse = |reason| {
        Err(AssetRefusal::new(
            reason,
            token,
            role,
            strategy_type,
            protocol,
            chain_id,
        ))
    };

    // The strategy/protocol pair maps to no universe at all — every asset is
    // implicitly rejected, so the rejection is about the universe, not the
    // token. Surface that distinctly from "token not allow-listed".
    let universe = supported_assets_for_config(strategy_type, chain_id, protocol, strategy_config);
    if universe.is_empty() {
        return refuse(UnsupportedAssetReason::UnknownUniverse);
    }

    // Token IS in the universe but mismatched on role — most actionable reason
    // for the operator, so check it before broader fallbacks.
    let token_in_universe_any_role = TradeAssetRole::all().iter().any(|&any_role| {
        any_role != role
            && is_supported_trade_asset_for_config(
                strategy_type,
                chain_id,
                protocol,
                token,
                any_role,
                strategy_config,
            )
            .is_some()
    });
    if token_in_universe_any_role {
        return refuse(UnsupportedAssetReason::RoleMismatch);
    }

    // Token is recognized on a different chain in the same protocol family.
    if token_matches_under(strategy_type, token, role, strategy_config, |asset| {
        asset.chain_id != registry_chain_id(chain_id)
            && asset.protocol == normalize_protocol(protocol)
    }) {
        return refuse(UnsupportedAssetReason::ChainMismatch);
    }

    // Token is recognized under a different protocol for this strategy.
    if token_matches_under(strategy_type, token, role, strategy_config, |asset| {
        asset.protocol != normalize_protocol(protocol)
    }) {
        return refuse(UnsupportedAssetReason::ProtocolMismatch);
    }

    refuse(UnsupportedAssetReason::OutOfUniverse)
}

/// Probe whether `token` matches any asset (under `role`) across the candidate
/// protocols/chains for `strategy_type` where `predicate` holds. Used to
/// classify near-miss refusal reasons (chain/protocol mismatch) without
/// hard-coding the protocol/chain tables here.
fn token_matches_under(
    strategy_type: &str,
    token: &str,
    role: TradeAssetRole,
    strategy_config: Option<&Value>,
    predicate: impl Fn(&SupportedAsset) -> bool,
) -> bool {
    let key = normalize_token(token);
    let normalized_strategy = normalize_strategy_type(strategy_type);

    for &candidate_protocol in candidate_protocols_for(&normalized_strategy) {
        for &candidate_chain in CANDIDATE_CHAIN_IDS {
            let assets = supported_assets_for_config(
                &normalized_strategy,
                candidate_chain,
                candidate_protocol,
                strategy_config,
            );
            let matched = assets.iter().any(|asset| {
                (normalize_token(&asset.address) == key || normalize_token(&asset.symbol) == key)
                    && asset.roles.contains(&role)
                    && predicate(asset)
            });
            if matched {
                return true;
            }
        }
    }
    false
}

/// Protocols that share an asset universe with `strategy_type`. Mirrors the
/// match arms in [`supported_assets_for`] so classification probes the same
/// surface the gate enforces.
fn candidate_protocols_for(strategy_type: &str) -> &'static [&'static str] {
    match strategy_type {
        "dex" | "mm" | "multi" => &["uniswap_v3", "aerodrome"],
        "yield" => &["aave_v3"],
        "hyperliquid_perp" => &["hyperliquid"],
        _ => &[],
    }
}

/// Chains probed when classifying a chain-mismatch refusal. Covers the chains
/// the default registries know about (Ethereum, Base, Base-Sepolia, Arbitrum,
/// HyperEVM testnet/mainnet) plus the local fork ids.
const CANDIDATE_CHAIN_IDS: &[u64] = &[1, 8453, 84532, 42161, 998, 999, 31337, 31338, 31339];

fn configured_assets_from_value(
    config: &Value,
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
) -> Option<Vec<SupportedAsset>> {
    let asset_universe = config.get("asset_universe");
    let configured = asset_universe
        .and_then(|universe| universe.get("allowed_assets"))
        .or_else(|| asset_universe.and_then(|universe| universe.get("assets")))
        .or_else(|| config.get("supported_assets"))?;

    // Track parse rejections so a malformed entry doesn't silently shrink
    // the universe. If EVERY entry fails, bail with `None` so callers fall
    // back to the default-asset registry rather than running a bot with
    // zero supported assets. Each rejection logs a warning with the reason.
    let total_entries = configured.as_array()?.len();
    let mut assets = Vec::new();
    let mut rejected = 0usize;
    for value in configured.as_array()?.iter() {
        match parse_supported_asset(value, strategy_type, chain_id, protocol) {
            Ok(asset) => assets.push(asset),
            Err(err) => {
                rejected += 1;
                warn!(
                    target: "supported_assets",
                    strategy = %strategy_type,
                    chain_id = chain_id,
                    protocol = %protocol,
                    error = ?err,
                    "rejected configured asset entry"
                );
            }
        }
    }

    if assets.is_empty() && rejected > 0 {
        warn!(
            target: "supported_assets",
            strategy = %strategy_type,
            chain_id = chain_id,
            protocol = %protocol,
            rejected = rejected,
            total = total_entries,
            "all configured asset entries rejected — falling back to default-asset registry"
        );
        return None;
    }

    Some(assets)
}

/// Parse a single configured asset entry. Returns a typed error on rejection
/// so the caller can log/metric per-entry reasons. Unknown valuation_adapter
/// strings are a hard error rather than a silent default — a typo must not
/// quietly route a custom token through the wrong pricing path.
pub fn parse_supported_asset(
    value: &Value,
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
) -> Result<SupportedAsset, SupportedAssetParseError> {
    let address = value
        .get("address")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or(SupportedAssetParseError::MissingAddress)?;

    // Full address validation, not just a hex-prefix sniff — anything
    // starting with `0x` would otherwise pass and poison the universe with
    // a "valid-shaped" garbage entry.
    Address::from_str(address)
        .map_err(|_| SupportedAssetParseError::InvalidAddress(address.to_string()))?;

    let symbol = value
        .get("symbol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|symbol| !symbol.is_empty())
        .unwrap_or("UNKNOWN");

    let asset_strategy = value
        .get("strategy_type")
        .and_then(Value::as_str)
        .unwrap_or(strategy_type);
    let normalized_asset_strategy = normalize_strategy_type(asset_strategy);
    let normalized_expected_strategy = normalize_strategy_type(strategy_type);
    if normalized_asset_strategy != normalized_expected_strategy {
        return Err(SupportedAssetParseError::StrategyMismatch {
            expected: normalized_expected_strategy,
            actual: normalized_asset_strategy,
        });
    }

    let asset_protocol = value
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or(protocol);
    let normalized_asset_protocol = normalize_protocol(asset_protocol);
    let normalized_expected_protocol = normalize_protocol(protocol);
    if normalized_asset_protocol != normalized_expected_protocol {
        return Err(SupportedAssetParseError::ProtocolMismatch {
            expected: normalized_expected_protocol,
            actual: normalized_asset_protocol,
        });
    }

    let asset_chain_id = value
        .get("chain_id")
        .and_then(Value::as_u64)
        .unwrap_or(chain_id);
    let normalized_asset_chain = registry_chain_id(asset_chain_id);
    let normalized_expected_chain = registry_chain_id(chain_id);
    if normalized_asset_chain != normalized_expected_chain {
        return Err(SupportedAssetParseError::ChainIdMismatch {
            expected: normalized_expected_chain,
            actual: normalized_asset_chain,
        });
    }

    let roles = value
        .get("roles")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|role| role.as_str().and_then(parse_trade_asset_role))
                .collect::<Vec<_>>()
        })
        .filter(|roles| !roles.is_empty())
        .unwrap_or_else(|| vec![TradeAssetRole::Input, TradeAssetRole::Output]);

    let decimals = value
        .get("decimals")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .or_else(|| token_metadata_for_chain(Some(chain_id), address).map(|token| token.decimals))
        .unwrap_or(18);

    // Unknown adapter strings are a hard error — a typo like "chinlink_usd"
    // surfaces here instead of being silently routed through ChainlinkUsd.
    let valuation_adapter =
        if let Some(raw) = value.get("valuation_adapter").and_then(Value::as_str) {
            parse_valuation_adapter_kind(raw)
                .ok_or_else(|| SupportedAssetParseError::UnknownValuationAdapter(raw.to_string()))?
        } else {
            ValuationAdapterKind::ChainlinkUsd
        };

    Ok(SupportedAsset {
        strategy_type: normalize_strategy_type(strategy_type),
        protocol: normalize_protocol(protocol),
        chain_id: registry_chain_id(chain_id),
        symbol: symbol.to_string(),
        address: address.to_string(),
        decimals,
        roles,
        valuation_adapter,
    })
}

fn parse_trade_asset_role(value: &str) -> Option<TradeAssetRole> {
    match value.trim().to_ascii_lowercase().as_str() {
        "input" => Some(TradeAssetRole::Input),
        "output" => Some(TradeAssetRole::Output),
        "collateral" => Some(TradeAssetRole::Collateral),
        "wrapper" => Some(TradeAssetRole::Wrapper),
        "debt" => Some(TradeAssetRole::Debt),
        _ => None,
    }
}

fn parse_valuation_adapter_kind(value: &str) -> Option<ValuationAdapterKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" => Some(ValuationAdapterKind::None),
        "chainlink_usd" | "chainlink" => Some(ValuationAdapterKind::ChainlinkUsd),
        "chainlink_or_uniswap_v3_twap" | "chainlink_or_twap" | "auto" => {
            Some(ValuationAdapterKind::ChainlinkOrUniswapV3Twap)
        }
        "uniswap_v3_twap" | "twap" => Some(ValuationAdapterKind::UniswapV3Twap),
        "wrapped_asset" | "wrapped" => Some(ValuationAdapterKind::WrappedAsset),
        _ => None,
    }
}

pub fn default_protocol_for_strategy(strategy_type: &str) -> Option<&'static str> {
    default_protocols_for_strategy(strategy_type)
        .first()
        .copied()
}

pub fn default_protocols_for_strategy(strategy_type: &str) -> &'static [&'static str] {
    match normalize_strategy_type(strategy_type).as_str() {
        "dex" => &["uniswap_v3"],
        "yield" => &["aave_v3"],
        "prediction" => &["polymarket_clob"],
        "hyperliquid_perp" => &["hyperliquid"],
        "perp" => &["gmx_v2", "vertex"],
        "volatility" => &[
            "polymarket_clob",
            "uniswap_v3",
            "gmx_v2",
            "hyperliquid",
            "vertex",
            "coingecko",
        ],
        _ => &[],
    }
}

pub fn normalize_strategy_type(strategy_type: &str) -> String {
    match strategy_type.trim().to_ascii_lowercase().as_str() {
        "dex" | "dex_trading" | "spot" => "dex".to_string(),
        "yield" | "defi_yield" | "aave" => "yield".to_string(),
        "prediction" | "prediction_market" => "prediction".to_string(),
        "hyperliquid_perp" | "hyperliquid-perp" | "hl_perp" | "hl-perp" => {
            "hyperliquid_perp".to_string()
        }
        "perp" | "perp_trading" | "perpetual" => "perp".to_string(),
        other => other.to_string(),
    }
}

fn dex_assets(chain_id: u64, protocol: &str) -> Vec<SupportedAsset> {
    ["WETH", "USDC"]
        .into_iter()
        .filter_map(|symbol| token_metadata_for_chain(Some(chain_id), symbol))
        .map(|token| SupportedAsset {
            strategy_type: "dex".to_string(),
            protocol: protocol.to_string(),
            chain_id,
            symbol: token.symbol.to_string(),
            address: token.address.to_string(),
            decimals: token.decimals,
            roles: vec![TradeAssetRole::Input, TradeAssetRole::Output],
            valuation_adapter: ValuationAdapterKind::ChainlinkUsd,
        })
        .collect()
}

fn aave_assets(chain_id: u64, protocol: &str) -> Vec<SupportedAsset> {
    let Some(market) = market_for_chain(chain_id) else {
        return Vec::new();
    };

    let mut assets = Vec::new();
    for reserve in market
        .reserves
        .iter()
        .filter(|reserve| matches!(reserve.symbol, "WETH" | "USDC"))
    {
        assets.push(SupportedAsset {
            strategy_type: "yield".to_string(),
            protocol: protocol.to_string(),
            chain_id,
            symbol: reserve.symbol.to_string(),
            address: reserve.underlying.to_string(),
            decimals: reserve.decimals,
            roles: vec![
                TradeAssetRole::Input,
                TradeAssetRole::Output,
                TradeAssetRole::Collateral,
            ],
            valuation_adapter: ValuationAdapterKind::ChainlinkUsd,
        });
        assets.push(SupportedAsset {
            strategy_type: "yield".to_string(),
            protocol: protocol.to_string(),
            chain_id,
            symbol: format!("a{}", reserve.symbol),
            address: reserve.a_token.to_string(),
            decimals: reserve.decimals,
            roles: vec![TradeAssetRole::Wrapper],
            valuation_adapter: ValuationAdapterKind::WrappedAsset,
        });
        assets.push(SupportedAsset {
            strategy_type: "yield".to_string(),
            protocol: protocol.to_string(),
            chain_id,
            symbol: format!("variableDebt{}", reserve.symbol),
            address: reserve.variable_debt_token.to_string(),
            decimals: reserve.decimals,
            roles: vec![TradeAssetRole::Debt],
            valuation_adapter: ValuationAdapterKind::WrappedAsset,
        });
    }
    assets
}

fn hyperliquid_perp_assets(chain_id: u64, protocol: &str) -> Vec<SupportedAsset> {
    token_metadata_for_chain(Some(chain_id), "USDC")
        .map(|token| SupportedAsset {
            strategy_type: "hyperliquid_perp".to_string(),
            protocol: protocol.to_string(),
            chain_id,
            symbol: token.symbol.to_string(),
            address: token.address.to_string(),
            decimals: token.decimals,
            roles: vec![TradeAssetRole::Input, TradeAssetRole::Collateral],
            valuation_adapter: ValuationAdapterKind::None,
        })
        .into_iter()
        .collect()
}

fn hyperliquid_perp_asset_from_config(
    chain_id: u64,
    protocol: &str,
    strategy_config: Option<&Value>,
) -> Option<SupportedAsset> {
    let asset_token = strategy_config
        .and_then(|config| config.get("asset_token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Address::from_str(asset_token).ok()?;
    let token = token_metadata_for_chain(Some(chain_id), asset_token);

    Some(SupportedAsset {
        strategy_type: "hyperliquid_perp".to_string(),
        protocol: protocol.to_string(),
        chain_id: registry_chain_id(chain_id),
        symbol: token
            .map(|token| token.symbol)
            .unwrap_or("USDC")
            .to_string(),
        address: asset_token.to_string(),
        decimals: token.map(|token| token.decimals).unwrap_or(6),
        roles: vec![TradeAssetRole::Input, TradeAssetRole::Collateral],
        valuation_adapter: ValuationAdapterKind::None,
    })
}

fn registry_chain_id(chain_id: u64) -> u64 {
    match chain_id {
        31337..=31339 => 1,
        _ => chain_id,
    }
}

fn normalize_protocol(protocol: &str) -> String {
    protocol.trim().to_ascii_lowercase()
}

fn normalize_token(token: &str) -> String {
    token.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());
    const HYPEREVM_TESTNET_USDC: &str = "0x2B3370eE501B4a559b57D449569354196457D8Ab";
    const CONFIGURED_HYPEREVM_MAINNET_USDC: &str = "0x1111111111111111111111111111111111110999";

    #[test]
    fn mm_and_multi_share_the_dex_asset_universe() {
        // Regression: an MM/multi DEX bot's spot tokens (WETH/USDC) must be in
        // the asset universe, else /validate rejects every rebalance swap as
        // "not in the configured asset universe" and the bot never trades.
        let usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
        let weth = "0x4200000000000000000000000000000000000006";
        for strat in ["mm", "multi", "dex"] {
            assert!(
                is_supported_trade_asset(strat, 84532, "aerodrome", usdc, TradeAssetRole::Input)
                    .is_some(),
                "{strat}: USDC must be a supported input on aerodrome/base-sepolia"
            );
            assert!(
                is_supported_trade_asset(strat, 84532, "aerodrome", weth, TradeAssetRole::Output)
                    .is_some(),
                "{strat}: WETH must be a supported output on aerodrome/base-sepolia"
            );
        }
    }

    #[test]
    fn dex_ethereum_fork_returns_weth_and_usdc() {
        let assets = supported_assets_for("dex", 31339, "uniswap_v3");
        let symbols = assets
            .iter()
            .map(|asset| asset.symbol.as_str())
            .collect::<Vec<_>>();

        assert_eq!(symbols, vec!["WETH", "USDC"]);
    }

    #[test]
    fn unsupported_random_dex_token_is_rejected() {
        let asset = is_supported_trade_asset(
            "dex",
            31339,
            "uniswap_v3",
            "0x000000000000000000000000000000000000dEaD",
            TradeAssetRole::Output,
        );

        assert!(asset.is_none());
    }

    #[test]
    fn configured_dex_assets_override_default_pair() {
        let config = serde_json::json!({
            "asset_universe": {
                "base_asset": "USDC",
                "allowed_assets": [{
                    "strategy_type": "dex",
                    "protocol": "uniswap_v3",
                    "chain_id": 1,
                    "symbol": "DAI",
                    "address": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
                    "decimals": 18,
                    "roles": ["input", "output"],
                    "valuation_adapter": "chainlink_usd"
                }]
            }
        });

        assert!(
            is_supported_trade_asset_for_config(
                "dex",
                1,
                "uniswap_v3",
                "DAI",
                TradeAssetRole::Input,
                Some(&config)
            )
            .is_some()
        );
        assert!(
            is_supported_trade_asset_for_config(
                "dex",
                1,
                "uniswap_v3",
                "WETH",
                TradeAssetRole::Input,
                Some(&config)
            )
            .is_none()
        );
    }

    #[test]
    fn configured_dex_assets_can_request_twap_fallback_valuation() {
        let config = serde_json::json!({
            "asset_universe": {
                "base_asset": "USDC",
                "allowed_assets": [{
                    "strategy_type": "dex",
                    "protocol": "uniswap_v3",
                    "chain_id": 1,
                    "symbol": "CUSTOM",
                    "address": "0x1111111111111111111111111111111111111111",
                    "decimals": 18,
                    "roles": ["input", "output"],
                    "valuation_adapter": "chainlink_or_uniswap_v3_twap"
                }]
            }
        });

        let asset = is_supported_trade_asset_for_config(
            "dex",
            1,
            "uniswap_v3",
            "0x1111111111111111111111111111111111111111",
            TradeAssetRole::Output,
            Some(&config),
        )
        .expect("custom asset should be supported by the configured asset universe");

        assert_eq!(
            asset.valuation_adapter,
            ValuationAdapterKind::ChainlinkOrUniswapV3Twap
        );
    }

    #[test]
    fn yield_ethereum_includes_aave_wrappers_and_debt_tokens() {
        let assets = supported_assets_for("yield", 1, "aave_v3");

        assert!(
            assets
                .iter()
                .any(|asset| asset.symbol == "aWETH"
                    && asset.roles.contains(&TradeAssetRole::Wrapper))
        );
        assert!(assets.iter().any(|asset| asset.symbol == "variableDebtWETH"
            && asset.roles.contains(&TradeAssetRole::Debt)));
    }

    #[test]
    fn hyperliquid_perp_hyperevm_uses_usdc_collateral_only() {
        let assets = supported_assets_for("hyperliquid_perp", 998, "hyperliquid");

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].strategy_type, "hyperliquid_perp");
        assert_eq!(assets[0].protocol, "hyperliquid");
        assert_eq!(assets[0].chain_id, 998);
        assert_eq!(assets[0].symbol, "USDC");
        assert_eq!(assets[0].address, HYPEREVM_TESTNET_USDC);
        assert_eq!(assets[0].decimals, 6);
        assert!(assets[0].roles.contains(&TradeAssetRole::Input));
        assert!(assets[0].roles.contains(&TradeAssetRole::Collateral));
        assert_eq!(assets[0].valuation_adapter, ValuationAdapterKind::None);
    }

    #[test]
    fn hyperliquid_perp_hyperevm_mainnet_uses_configured_usdc_collateral() {
        let _lock = ENV_LOCK.lock().expect("env lock");
        // SAFETY: this test serializes writes to the HyperEVM mainnet token
        // env keys and restores the previous values before returning.
        let previous_runtime = std::env::var("HYPEREVM_MAINNET_USDC_ASSET_TOKEN").ok();
        let previous_vite = std::env::var("VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN").ok();
        unsafe {
            std::env::set_var(
                "HYPEREVM_MAINNET_USDC_ASSET_TOKEN",
                CONFIGURED_HYPEREVM_MAINNET_USDC,
            );
            std::env::remove_var("VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN");
        }

        let assets = supported_assets_for("hyperliquid_perp", 999, "hyperliquid");

        unsafe {
            match previous_runtime {
                Some(value) => std::env::set_var("HYPEREVM_MAINNET_USDC_ASSET_TOKEN", value),
                None => std::env::remove_var("HYPEREVM_MAINNET_USDC_ASSET_TOKEN"),
            }
            match previous_vite {
                Some(value) => std::env::set_var("VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN", value),
                None => std::env::remove_var("VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN"),
            }
        }

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].strategy_type, "hyperliquid_perp");
        assert_eq!(assets[0].protocol, "hyperliquid");
        assert_eq!(assets[0].chain_id, 999);
        assert_eq!(assets[0].symbol, "USDC");
        assert_eq!(assets[0].address, CONFIGURED_HYPEREVM_MAINNET_USDC);
        assert_eq!(assets[0].decimals, 6);
        assert!(assets[0].roles.contains(&TradeAssetRole::Input));
        assert!(assets[0].roles.contains(&TradeAssetRole::Collateral));
        assert_eq!(assets[0].valuation_adapter, ValuationAdapterKind::None);
    }

    #[test]
    fn hyperliquid_perp_mainnet_uses_provisioned_asset_token_without_env() {
        let _lock = ENV_LOCK.lock().expect("env lock");
        let previous_runtime = std::env::var("HYPEREVM_MAINNET_USDC_ASSET_TOKEN").ok();
        let previous_vite = std::env::var("VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN").ok();
        unsafe {
            std::env::remove_var("HYPEREVM_MAINNET_USDC_ASSET_TOKEN");
            std::env::remove_var("VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN");
        }

        let config = serde_json::json!({
            "strategy_type": "hyperliquid_perp",
            "asset_token": CONFIGURED_HYPEREVM_MAINNET_USDC
        });
        let assets =
            supported_assets_for_config("hyperliquid_perp", 999, "hyperliquid", Some(&config));

        unsafe {
            match previous_runtime {
                Some(value) => std::env::set_var("HYPEREVM_MAINNET_USDC_ASSET_TOKEN", value),
                None => std::env::remove_var("HYPEREVM_MAINNET_USDC_ASSET_TOKEN"),
            }
            match previous_vite {
                Some(value) => std::env::set_var("VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN", value),
                None => std::env::remove_var("VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN"),
            }
        }

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].strategy_type, "hyperliquid_perp");
        assert_eq!(assets[0].protocol, "hyperliquid");
        assert_eq!(assets[0].chain_id, 999);
        assert_eq!(assets[0].symbol, "USDC");
        assert_eq!(assets[0].address, CONFIGURED_HYPEREVM_MAINNET_USDC);
        assert_eq!(assets[0].decimals, 6);
        assert!(assets[0].roles.contains(&TradeAssetRole::Input));
        assert!(assets[0].roles.contains(&TradeAssetRole::Collateral));
        assert_eq!(assets[0].valuation_adapter, ValuationAdapterKind::None);
    }

    #[test]
    fn generic_perp_no_longer_defaults_to_hyperliquid() {
        assert_eq!(default_protocol_for_strategy("perp"), Some("gmx_v2"));
        assert_eq!(
            default_protocols_for_strategy("perp"),
            &["gmx_v2", "vertex"]
        );
        assert_eq!(
            default_protocol_for_strategy("hyperliquid_perp"),
            Some("hyperliquid")
        );
    }

    #[test]
    fn volatility_defaults_expose_all_research_and_execution_protocols() {
        assert_eq!(
            default_protocols_for_strategy("volatility"),
            &[
                "polymarket_clob",
                "uniswap_v3",
                "gmx_v2",
                "hyperliquid",
                "vertex",
                "coingecko"
            ]
        );
    }

    // ── parse-error surface + fallback behavior ─────────────────────────────

    /// Parse error surfaces a typed reason for malformed addresses (was: silent None).
    #[test]
    fn parse_supported_asset_rejects_invalid_address() {
        let value = serde_json::json!({"address":"0xnotreallyanaddress","symbol":"X"});
        let err = parse_supported_asset(&value, "dex", 1, "uniswap_v3").unwrap_err();
        assert_eq!(
            err,
            SupportedAssetParseError::InvalidAddress("0xnotreallyanaddress".into())
        );
    }

    /// Parse error surfaces a typed reason for unknown valuation_adapter strings
    /// (was: silent default to ChainlinkUsd, which let typos misroute tokens).
    #[test]
    fn parse_supported_asset_rejects_unknown_adapter() {
        let value = serde_json::json!({
            "address": "0x0000000000000000000000000000000000000001",
            "symbol": "X",
            "valuation_adapter": "chinlink_usd"
        });
        let err = parse_supported_asset(&value, "dex", 1, "uniswap_v3").unwrap_err();
        assert_eq!(
            err,
            SupportedAssetParseError::UnknownValuationAdapter("chinlink_usd".into())
        );
    }

    /// Strategy / protocol / chain mismatches produce typed errors (was: silent None).
    #[test]
    fn parse_supported_asset_rejects_chain_mismatch() {
        let value = serde_json::json!({
            "address":"0x0000000000000000000000000000000000000001",
            "chain_id": 42161,
            "symbol":"X"
        });
        let err = parse_supported_asset(&value, "dex", 1, "uniswap_v3").unwrap_err();
        assert!(matches!(
            err,
            SupportedAssetParseError::ChainIdMismatch {
                expected: 1,
                actual: 42161
            }
        ));
    }

    /// When EVERY configured entry fails to parse we fall back to the default
    /// registry instead of running the bot with a zero-asset universe (was:
    /// configured_assets_from_value returned `Some(empty Vec)` and the bot
    /// silently had nothing to trade).
    #[test]
    fn configured_assets_falls_back_to_default_when_all_entries_invalid() {
        let bad_config = serde_json::json!({
            "asset_universe": {
                "allowed_assets": [
                    {"address":"not_hex","symbol":"X"},
                    {"address":"0xnotreallyanaddress","symbol":"Y"}
                ]
            }
        });
        let assets = supported_assets_for_config("dex", 1, "uniswap_v3", Some(&bad_config));
        // Falls back to default registry, which has WETH + USDC for ethereum / uniswap_v3.
        assert!(
            !assets.is_empty(),
            "all-invalid config should fall back to defaults instead of empty universe"
        );
    }

    // ── G6: declared-universe gate — typed refusal, no silent skip ──────────

    const BASE_SEPOLIA_USDC: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const RANDOM_TOKEN: &str = "0x000000000000000000000000000000000000dEaD";

    /// In-universe asset passes the gate and returns the matched asset (not an
    /// empty/None that downstream misreads as "no restriction").
    #[test]
    fn gate_accepts_in_universe_asset() {
        let asset = gate_trade_asset(
            "dex",
            84532,
            "aerodrome",
            BASE_SEPOLIA_USDC,
            TradeAssetRole::Input,
        )
        .expect("USDC is in the dex/aerodrome universe and must pass the gate");
        assert_eq!(asset.symbol, "USDC");
        assert!(asset.roles.contains(&TradeAssetRole::Input));
    }

    /// Out-of-universe asset yields a STRUCTURED refusal — the whole point of
    /// G6. Regression: previously `is_supported_trade_asset` returned `None`
    /// and the swap was silently skipped with no machine-readable reason.
    #[test]
    fn gate_refuses_out_of_universe_asset_with_structured_reason() {
        let refusal = gate_trade_asset(
            "dex",
            84532,
            "aerodrome",
            RANDOM_TOKEN,
            TradeAssetRole::Output,
        )
        .expect_err("a random token must be refused, not silently skipped");

        assert_eq!(refusal.refusal, AssetRefusal::REFUSAL);
        assert_eq!(refusal.reason, UnsupportedAssetReason::OutOfUniverse);
        assert_eq!(refusal.asset, RANDOM_TOKEN);
        assert_eq!(refusal.role, TradeAssetRole::Output);
        assert_eq!(refusal.chain_id, 84532);

        // The wire envelope is the contract downstream parses.
        let json: serde_json::Value =
            serde_json::from_str(&refusal.to_json()).expect("refusal serializes to JSON");
        assert_eq!(json["refusal"], "asset_not_in_universe");
        assert_eq!(json["reason"], "out_of_universe");
        assert_eq!(json["asset"], RANDOM_TOKEN);
    }

    /// A strategy/protocol pair with no registry universe rejects every asset
    /// with `UnknownUniverse` — distinct from "token not allow-listed". This is
    /// the case the old empty-`Vec` return collapsed into silence.
    #[test]
    fn gate_refuses_unknown_universe_when_protocol_unsupported() {
        let refusal = gate_trade_asset(
            "dex",
            84532,
            "sushiswap", // no universe mapped for dex/sushiswap
            BASE_SEPOLIA_USDC,
            TradeAssetRole::Input,
        )
        .expect_err("an unmapped protocol must refuse, not return an empty universe");
        assert_eq!(refusal.reason, UnsupportedAssetReason::UnknownUniverse);
    }

    /// Token is in the universe but used in a disallowed role → RoleMismatch,
    /// not OutOfUniverse. A custom output-only token used as an Input must be
    /// refused with the precise reason — the gate must distinguish "you used a
    /// known token in the wrong role" from "unknown token". A per-config
    /// universe is used so the role set is exact and not collapsed by the
    /// aToken→underlying metadata aliasing.
    #[test]
    fn gate_refuses_role_mismatch_for_output_only_token() {
        let output_only = "0x2222222222222222222222222222222222222222";
        let config = serde_json::json!({
            "asset_universe": {
                "allowed_assets": [{
                    "strategy_type": "dex",
                    "protocol": "uniswap_v3",
                    "chain_id": 1,
                    "symbol": "OUTONLY",
                    "address": output_only,
                    "decimals": 18,
                    "roles": ["output"],
                    "valuation_adapter": "chainlink_usd"
                }]
            }
        });

        let refusal = gate_trade_asset_for_config(
            "dex",
            1,
            "uniswap_v3",
            output_only,
            TradeAssetRole::Input,
            Some(&config),
        )
        .expect_err("an output-only token used as Input must be refused");
        assert_eq!(refusal.reason, UnsupportedAssetReason::RoleMismatch);

        // Sanity: the same token IS accepted in its declared role.
        assert!(
            gate_trade_asset_for_config(
                "dex",
                1,
                "uniswap_v3",
                output_only,
                TradeAssetRole::Output,
                Some(&config),
            )
            .is_ok()
        );
    }

    /// Token is valid but on the wrong chain → ChainMismatch. WETH exists in
    /// the dex universe on Ethereum (chain 1); requesting it on a chain whose
    /// registry has a different WETH address surfaces the chain-mismatch reason
    /// rather than a generic out-of-universe refusal.
    #[test]
    fn gate_refuses_chain_mismatch_for_cross_chain_address() {
        // Ethereum-mainnet USDC address, requested on Base-Sepolia where the
        // USDC address differs — same symbol family, wrong chain.
        let eth_usdc = supported_assets_for("dex", 1, "uniswap_v3")
            .into_iter()
            .find(|asset| asset.symbol == "USDC")
            .expect("ethereum dex universe has USDC");

        // Only meaningful if the addresses actually differ across chains.
        if eth_usdc.address.eq_ignore_ascii_case(BASE_SEPOLIA_USDC) {
            return;
        }

        let refusal = gate_trade_asset(
            "dex",
            84532,
            "aerodrome",
            &eth_usdc.address,
            TradeAssetRole::Input,
        )
        .expect_err("an ethereum-address USDC on base-sepolia must be refused");
        assert_eq!(refusal.reason, UnsupportedAssetReason::ChainMismatch);
    }

    /// Config-aware gate honors a per-bot universe override: a configured custom
    /// token passes, a default-pair token now outside the override is refused
    /// with a structured reason (not silently dropped).
    #[test]
    fn gate_for_config_enforces_override_universe() {
        let config = serde_json::json!({
            "asset_universe": {
                "allowed_assets": [{
                    "strategy_type": "dex",
                    "protocol": "uniswap_v3",
                    "chain_id": 1,
                    "symbol": "DAI",
                    "address": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
                    "decimals": 18,
                    "roles": ["input", "output"],
                    "valuation_adapter": "chainlink_usd"
                }]
            }
        });

        assert!(
            gate_trade_asset_for_config(
                "dex",
                1,
                "uniswap_v3",
                "DAI",
                TradeAssetRole::Input,
                Some(&config)
            )
            .is_ok()
        );

        let refusal = gate_trade_asset_for_config(
            "dex",
            1,
            "uniswap_v3",
            "WETH",
            TradeAssetRole::Input,
            Some(&config),
        )
        .expect_err("WETH is outside the override universe and must be refused");
        assert_eq!(refusal.refusal, AssetRefusal::REFUSAL);
    }

    /// The reason wire codes are stable and decoupled from serde variant names.
    #[test]
    fn unsupported_asset_reason_codes_are_stable() {
        assert_eq!(
            UnsupportedAssetReason::OutOfUniverse.code(),
            "out_of_universe"
        );
        assert_eq!(
            UnsupportedAssetReason::UnknownUniverse.code(),
            "unknown_universe"
        );
        assert_eq!(
            UnsupportedAssetReason::ChainMismatch.code(),
            "chain_mismatch"
        );
        assert_eq!(
            UnsupportedAssetReason::ProtocolMismatch.code(),
            "protocol_mismatch"
        );
        assert_eq!(UnsupportedAssetReason::RoleMismatch.code(), "role_mismatch");
    }
}
