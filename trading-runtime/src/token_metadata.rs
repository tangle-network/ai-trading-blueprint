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

const ETHEREUM_TOKENS: &[TokenMetadata] = &[
    ETHEREUM_WETH,
    ETHEREUM_USDC,
    ETHEREUM_USDT,
    ETHEREUM_DAI,
    ETHEREUM_WBTC,
];
const BASE_TOKENS: &[TokenMetadata] = &[BASE_WETH, BASE_USDC, BASE_CBBTC];
const BASE_SEPOLIA_TOKENS: &[TokenMetadata] = &[BASE_WETH, BASE_USDC_SEPOLIA];

pub fn normalize_token_key(token: &str) -> String {
    token.trim().to_ascii_lowercase()
}

pub fn chain_display_name(chain_id: u64) -> &'static str {
    match chain_id {
        84532 => "Base Sepolia",
        8453 => "Base",
        1 => "Ethereum mainnet",
        31337 => "Ethereum fork",
        31339 => "Ethereum local fork",
        _ => "unknown chain",
    }
}

pub fn tokens_for_chain(chain_id: u64) -> &'static [TokenMetadata] {
    match chain_id {
        8453 => BASE_TOKENS,
        84532 => BASE_SEPOLIA_TOKENS,
        1 | 31337 | 31339 => ETHEREUM_TOKENS,
        _ => &[],
    }
}

pub fn token_metadata_for_chain(
    chain_id: Option<u64>,
    token: &str,
) -> Option<&'static TokenMetadata> {
    let chain_id = chain_id?;
    let key = normalize_token_key(token);
    tokens_for_chain(chain_id)
        .iter()
        .find(|metadata| token_matches(metadata, &key))
}

pub fn token_address_for_symbol(chain_id: u64, symbol: &str) -> Option<&'static str> {
    let key = normalize_token_key(symbol);
    tokens_for_chain(chain_id)
        .iter()
        .find(|metadata| key == metadata.symbol.to_ascii_lowercase())
        .map(|metadata| metadata.address)
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

    for candidate_chain in [84532_u64, 8453, 1, 31337, 31339] {
        if candidate_chain == chain_id {
            continue;
        }
        if token_metadata_for_chain(Some(candidate_chain), token).is_some() {
            return Some(candidate_chain);
        }
    }
    None
}

fn token_metadata_across_known_chains(token: &str) -> Option<&'static TokenMetadata> {
    let key = normalize_token_key(token);
    [84532_u64, 8453, 1, 31337, 31339]
        .into_iter()
        .flat_map(tokens_for_chain)
        .find(|metadata| token_matches(metadata, &key))
}

fn token_matches(metadata: &TokenMetadata, key: &str) -> bool {
    key == metadata.address.to_ascii_lowercase()
        || key == metadata.symbol.to_ascii_lowercase()
        || metadata
            .aliases
            .iter()
            .any(|alias| key == alias.to_ascii_lowercase())
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
