use crate::aave_v3_registry::{
    AAVE_V3_MARKETS, AaveReserve, reserve_by_any_token, reserve_by_symbol,
};
use alloy::primitives::Address;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenMetadata {
    pub symbol: &'static str,
    pub address: &'static str,
    pub decimals: u8,
    pub coingecko_id: Option<&'static str>,
    aliases: &'static [&'static str],
}

const WETH_ALIASES: &[&str] = &["weth", "eth"];
const USDC_ALIASES: &[&str] = &["usdc"];
const USDT_ALIASES: &[&str] = &["usdt"];
const DAI_ALIASES: &[&str] = &["dai"];
const WBTC_ALIASES: &[&str] = &["wbtc", "btc"];
const CBBTC_ALIASES: &[&str] = &["cbbtc", "wbtc", "btc"];

const ETHEREUM_WETH: TokenMetadata = TokenMetadata {
    symbol: "WETH",
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
    coingecko_id: Some("ethereum"),
    aliases: WETH_ALIASES,
};
const ETHEREUM_USDC: TokenMetadata = TokenMetadata {
    symbol: "USDC",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    coingecko_id: Some("usd-coin"),
    aliases: USDC_ALIASES,
};
const ETHEREUM_USDT: TokenMetadata = TokenMetadata {
    symbol: "USDT",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    coingecko_id: Some("tether"),
    aliases: USDT_ALIASES,
};
const ETHEREUM_DAI: TokenMetadata = TokenMetadata {
    symbol: "DAI",
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    decimals: 18,
    coingecko_id: Some("dai"),
    aliases: DAI_ALIASES,
};
const ETHEREUM_WBTC: TokenMetadata = TokenMetadata {
    symbol: "WBTC",
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    decimals: 8,
    coingecko_id: Some("bitcoin"),
    aliases: WBTC_ALIASES,
};

const BASE_WETH: TokenMetadata = TokenMetadata {
    symbol: "WETH",
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    coingecko_id: Some("ethereum"),
    aliases: WETH_ALIASES,
};
const BASE_USDC: TokenMetadata = TokenMetadata {
    symbol: "USDC",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    coingecko_id: Some("usd-coin"),
    aliases: USDC_ALIASES,
};
const BASE_USDC_SEPOLIA: TokenMetadata = TokenMetadata {
    symbol: "USDC",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    coingecko_id: Some("usd-coin"),
    aliases: USDC_ALIASES,
};
const BASE_CBBTC: TokenMetadata = TokenMetadata {
    symbol: "cbBTC",
    address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
    decimals: 8,
    coingecko_id: Some("bitcoin"),
    aliases: CBBTC_ALIASES,
};

const ARBITRUM_WETH: TokenMetadata = TokenMetadata {
    symbol: "WETH",
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    decimals: 18,
    coingecko_id: Some("ethereum"),
    aliases: WETH_ALIASES,
};
const ARBITRUM_USDC: TokenMetadata = TokenMetadata {
    symbol: "USDC",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6,
    coingecko_id: Some("usd-coin"),
    aliases: USDC_ALIASES,
};
const HYPEREVM_TESTNET_USDC: TokenMetadata = TokenMetadata {
    symbol: "USDC",
    address: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
    decimals: 6,
    coingecko_id: Some("usd-coin"),
    aliases: USDC_ALIASES,
};
const HYPEREVM_MAINNET_USDC_ENV_KEYS: &[&str] = &[
    "HYPEREVM_MAINNET_USDC_ASSET_TOKEN",
    "VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN",
];
static CONFIGURED_ADDRESS_INTERNER: OnceLock<Mutex<Vec<&'static str>>> = OnceLock::new();

const ETHEREUM_TOKENS: &[TokenMetadata] = &[
    ETHEREUM_WETH,
    ETHEREUM_USDC,
    ETHEREUM_USDT,
    ETHEREUM_DAI,
    ETHEREUM_WBTC,
];
const BASE_TOKENS: &[TokenMetadata] = &[BASE_WETH, BASE_USDC, BASE_CBBTC];
const BASE_SEPOLIA_TOKENS: &[TokenMetadata] = &[BASE_WETH, BASE_USDC_SEPOLIA];
const ARBITRUM_TOKENS: &[TokenMetadata] = &[ARBITRUM_WETH, ARBITRUM_USDC];
const HYPEREVM_TESTNET_TOKENS: &[TokenMetadata] = &[HYPEREVM_TESTNET_USDC];

pub fn normalize_token_key(token: &str) -> String {
    token.trim().to_ascii_lowercase()
}

pub fn chain_display_name(chain_id: u64) -> &'static str {
    match chain_id {
        84532 => "Base Sepolia",
        8453 => "Base",
        42161 => "Arbitrum",
        137 => "Polygon",
        10 => "Optimism",
        43114 => "Avalanche",
        998 => "HyperEVM testnet",
        999 => "HyperEVM mainnet",
        1 => "Ethereum mainnet",
        31337 => "Ethereum fork",
        31338 | 31339 => "Ethereum local fork",
        _ => "unknown chain",
    }
}

pub fn tokens_for_chain(chain_id: u64) -> &'static [TokenMetadata] {
    match chain_id {
        8453 => BASE_TOKENS,
        84532 => BASE_SEPOLIA_TOKENS,
        42161 => ARBITRUM_TOKENS,
        998 => HYPEREVM_TESTNET_TOKENS,
        1 | 31337 | 31338 | 31339 => ETHEREUM_TOKENS,
        _ => &[],
    }
}

pub fn token_metadata_for_chain(chain_id: Option<u64>, token: &str) -> Option<TokenMetadata> {
    let chain_id = chain_id?;
    let key = normalize_token_key(token);
    if let Some(metadata) = configured_token_metadata_for_chain(chain_id, &key) {
        return Some(metadata);
    }

    tokens_for_chain(chain_id)
        .iter()
        .find(|metadata| token_matches(metadata, &key))
        .copied()
        .or_else(|| {
            let registry_chain_id = aave_registry_chain_id(chain_id);
            reserve_by_any_token(registry_chain_id, token)
                .or_else(|| reserve_by_symbol(registry_chain_id, token))
                .map(token_metadata_from_aave_reserve)
        })
}

pub fn token_address_for_symbol(chain_id: u64, symbol: &str) -> Option<&'static str> {
    let key = normalize_token_key(symbol);
    if let Some(metadata) = configured_token_metadata_for_chain(chain_id, &key) {
        return Some(metadata.address);
    }

    tokens_for_chain(chain_id)
        .iter()
        .find(|metadata| key == metadata.symbol.to_ascii_lowercase())
        .map(|metadata| metadata.address)
        .or_else(|| {
            reserve_by_symbol(aave_registry_chain_id(chain_id), symbol)
                .map(|reserve| reserve.underlying)
        })
}

pub fn known_token_decimals(chain_id: Option<u64>, token: &str) -> Option<u8> {
    token_metadata_for_chain(chain_id, token).map(|metadata| metadata.decimals)
}

pub fn coingecko_id_for_token(chain_id: Option<u64>, token: &str) -> Option<&'static str> {
    token_metadata_for_chain(chain_id, token)
        .and_then(|metadata| metadata.coingecko_id)
        .or_else(|| {
            token_metadata_across_known_chains(token).and_then(|metadata| metadata.coingecko_id)
        })
}

pub fn address_chain_mismatch(chain_id: u64, token: &str) -> Option<u64> {
    let key = normalize_token_key(token);
    if !key.starts_with("0x") {
        return None;
    }
    if token_metadata_for_chain(Some(chain_id), token).is_some() {
        return None;
    }

    for candidate_chain in known_chain_ids() {
        if candidate_chain == chain_id {
            continue;
        }
        if token_metadata_for_chain(Some(candidate_chain), token).is_some() {
            return Some(candidate_chain);
        }
    }
    None
}

fn token_metadata_across_known_chains(token: &str) -> Option<TokenMetadata> {
    let key = normalize_token_key(token);
    known_chain_ids()
        .into_iter()
        .flat_map(tokens_for_chain)
        .find(|metadata| token_matches(metadata, &key))
        .copied()
        .or_else(|| {
            AAVE_V3_MARKETS
                .iter()
                .find_map(|market| {
                    market.reserves.iter().find(|reserve| {
                        normalize_token_key(reserve.underlying) == key
                            || normalize_token_key(reserve.a_token) == key
                            || normalize_token_key(reserve.variable_debt_token) == key
                            || normalize_token_key(reserve.symbol) == key
                            || reserve
                                .aliases
                                .iter()
                                .any(|alias| normalize_token_key(alias) == key)
                    })
                })
                .map(token_metadata_from_aave_reserve)
        })
}

fn configured_token_metadata_for_chain(chain_id: u64, key: &str) -> Option<TokenMetadata> {
    match chain_id {
        999 => configured_hyperevm_mainnet_usdc().filter(|metadata| token_matches(metadata, key)),
        _ => None,
    }
}

fn configured_hyperevm_mainnet_usdc() -> Option<TokenMetadata> {
    // HyperEVM mainnet USDC is intentionally configured instead of hardcoded:
    // this repo only commits the testnet address, while Arena exposes chain
    // 999 through VITE_HYPEREVM_MAINNET_USDC_ASSET_TOKEN.
    configured_address(HYPEREVM_MAINNET_USDC_ENV_KEYS).map(|address| TokenMetadata {
        symbol: "USDC",
        address,
        decimals: 6,
        coingecko_id: Some("usd-coin"),
        aliases: USDC_ALIASES,
    })
}

fn configured_address(env_keys: &[&str]) -> Option<&'static str> {
    env_keys
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty() && Address::from_str(value).is_ok())
        .map(intern_configured_address)
}

fn intern_configured_address(value: String) -> &'static str {
    let interner = CONFIGURED_ADDRESS_INTERNER.get_or_init(|| Mutex::new(Vec::new()));
    let mut values = interner.lock().expect("configured address interner lock");
    if let Some(existing) = values
        .iter()
        .find(|existing| existing.eq_ignore_ascii_case(&value))
    {
        return existing;
    }

    let leaked = Box::leak(value.into_boxed_str()) as &'static str;
    values.push(leaked);
    leaked
}

fn token_matches(metadata: &TokenMetadata, key: &str) -> bool {
    key == metadata.address.to_ascii_lowercase()
        || key == metadata.symbol.to_ascii_lowercase()
        || metadata
            .aliases
            .iter()
            .any(|alias| key == alias.to_ascii_lowercase())
}

fn token_metadata_from_aave_reserve(reserve: &AaveReserve) -> TokenMetadata {
    TokenMetadata {
        symbol: reserve.symbol,
        address: reserve.underlying,
        decimals: reserve.decimals,
        coingecko_id: reserve.coingecko_id,
        aliases: reserve.aliases,
    }
}

fn known_chain_ids() -> Vec<u64> {
    let mut ids = vec![999_u64, 998, 84532, 8453, 42161, 1, 31337, 31338, 31339];
    ids.extend(AAVE_V3_MARKETS.iter().map(|market| market.chain_id));
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn aave_registry_chain_id(chain_id: u64) -> u64 {
    match chain_id {
        31338 | 31339 => 1,
        _ => chain_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_sepolia_usdc_is_known() {
        let metadata =
            token_metadata_for_chain(Some(84532), "0x036CbD53842c5426634e7929541eC2318f3dCF7e")
                .expect("base sepolia usdc");
        assert_eq!(metadata.symbol, "USDC");
        assert_eq!(metadata.decimals, 6);
    }

    #[test]
    fn hyperevm_testnet_usdc_is_known() {
        let metadata =
            token_metadata_for_chain(Some(998), "0x2B3370eE501B4a559b57D449569354196457D8Ab")
                .expect("hyperevm testnet usdc");
        assert_eq!(metadata.symbol, "USDC");
        assert_eq!(metadata.decimals, 6);
    }

    #[test]
    fn aave_registry_tokens_are_known_on_supported_chains() {
        let metadata =
            token_metadata_for_chain(Some(42161), "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8")
                .expect("arbitrum aave usdc");
        assert_eq!(metadata.symbol, "USDC");
        assert_eq!(metadata.decimals, 6);

        let a_token =
            token_metadata_for_chain(Some(8453), "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB")
                .expect("base ausdc");
        assert_eq!(a_token.symbol, "USDC");
        assert_eq!(a_token.decimals, 6);

        let fork_a_token =
            token_metadata_for_chain(Some(31339), "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c")
                .expect("ethereum fork ausdc");
        assert_eq!(fork_a_token.symbol, "USDC");
    }

    #[test]
    fn detect_mainnet_address_on_wrong_chain() {
        assert_eq!(
            address_chain_mismatch(84532, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
            Some(1)
        );
    }

    #[test]
    fn symbol_lookup_uses_current_chain() {
        assert_eq!(
            token_address_for_symbol(84532, "WETH"),
            Some("0x4200000000000000000000000000000000000006")
        );
        assert_eq!(
            token_address_for_symbol(84532, "USDC"),
            Some("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
        );
    }
}
