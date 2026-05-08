use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::aave_v3_registry::market_for_chain;
use crate::token_metadata::token_metadata_for_chain;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TradeAssetRole {
    Input,
    Output,
    Collateral,
    Wrapper,
    Debt,
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
        ("dex", "uniswap_v3" | "aerodrome") => dex_assets(registry_chain_id, &normalized_protocol),
        ("yield", "aave_v3") => aave_assets(registry_chain_id, &normalized_protocol),
        _ => Vec::new(),
    }
}

pub fn supported_assets_for_config(
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
    strategy_config: Option<&Value>,
) -> Vec<SupportedAsset> {
    if let Some(configured) = strategy_config
        .and_then(|config| configured_assets_from_value(config, strategy_type, chain_id, protocol))
    {
        return configured;
    }

    supported_assets_for(strategy_type, chain_id, protocol)
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

    let assets = configured
        .as_array()?
        .iter()
        .filter_map(|value| parse_supported_asset(value, strategy_type, chain_id, protocol))
        .collect::<Vec<_>>();

    Some(assets)
}

fn parse_supported_asset(
    value: &Value,
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
) -> Option<SupportedAsset> {
    let address = value.get("address")?.as_str()?.trim();
    if !address.starts_with("0x") {
        return None;
    }

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
    if normalize_strategy_type(asset_strategy) != normalize_strategy_type(strategy_type) {
        return None;
    }

    let asset_protocol = value
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or(protocol);
    if normalize_protocol(asset_protocol) != normalize_protocol(protocol) {
        return None;
    }

    let asset_chain_id = value
        .get("chain_id")
        .and_then(Value::as_u64)
        .unwrap_or(chain_id);
    if registry_chain_id(asset_chain_id) != registry_chain_id(chain_id) {
        return None;
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

    let valuation_adapter = value
        .get("valuation_adapter")
        .and_then(Value::as_str)
        .and_then(parse_valuation_adapter_kind)
        .unwrap_or(ValuationAdapterKind::ChainlinkUsd);

    Some(SupportedAsset {
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
    match normalize_strategy_type(strategy_type).as_str() {
        "dex" => Some("uniswap_v3"),
        "yield" => Some("aave_v3"),
        "prediction" => Some("polymarket_clob"),
        "perp" => Some("hyperliquid"),
        _ => None,
    }
}

pub fn normalize_strategy_type(strategy_type: &str) -> String {
    match strategy_type.trim().to_ascii_lowercase().as_str() {
        "dex" | "dex_trading" | "spot" => "dex".to_string(),
        "yield" | "defi_yield" | "aave" => "yield".to_string(),
        "prediction" | "prediction_market" => "prediction".to_string(),
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
}
