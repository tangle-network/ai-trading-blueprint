use serde::{Deserialize, Serialize};

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

pub fn is_supported_trade_asset(
    strategy_type: &str,
    chain_id: u64,
    protocol: &str,
    token: &str,
    role: TradeAssetRole,
) -> Option<SupportedAsset> {
    let key = normalize_token(token);
    let resolved_address = token_metadata_for_chain(Some(chain_id), token)
        .map(|metadata| normalize_token(metadata.address));
    supported_assets_for(strategy_type, chain_id, protocol)
        .into_iter()
        .find(|asset| {
            ((normalize_token(&asset.address) == key || normalize_token(&asset.symbol) == key)
                || resolved_address
                    .as_deref()
                    .is_some_and(|address| normalize_token(&asset.address) == address))
                && asset.roles.contains(&role)
        })
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
