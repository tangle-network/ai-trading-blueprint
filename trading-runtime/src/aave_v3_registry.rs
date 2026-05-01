/// Static Aave V3 market data used for pre-signing validation and calldata
/// encoding. Addresses are sourced from @aave-dao/aave-address-book v4.49.8.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AaveMarket {
    pub chain_id: u64,
    pub name: &'static str,
    pub pool: &'static str,
    pub pool_addresses_provider: &'static str,
    pub protocol_data_provider: &'static str,
    pub reserves: &'static [AaveReserve],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AaveReserve {
    pub symbol: &'static str,
    pub aliases: &'static [&'static str],
    pub underlying: &'static str,
    pub a_token: &'static str,
    pub variable_debt_token: &'static str,
    pub decimals: u8,
    pub variable_borrow_enabled: bool,
    pub coingecko_id: Option<&'static str>,
}

const WETH_ALIASES: &[&str] = &["weth", "eth"];
const USDC_ALIASES: &[&str] = &["usdc"];
const USDBC_ALIASES: &[&str] = &["usdbc", "usd-coin"];
const USDT_ALIASES: &[&str] = &["usdt", "usdt0"];
const DAI_ALIASES: &[&str] = &["dai"];
const WBTC_ALIASES: &[&str] = &["wbtc", "btc"];
const CBBTC_ALIASES: &[&str] = &["cbbtc", "wbtc", "btc"];
const WAVAX_ALIASES: &[&str] = &["wavax", "avax"];

const ETHEREUM_RESERVES: &[AaveReserve] = &[
    reserve(
        "WETH",
        WETH_ALIASES,
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
        "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
        18,
        Some("ethereum"),
    ),
    reserve(
        "USDC",
        USDC_ALIASES,
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
        "0x72E95b8931767C79bA4EeE721354d6E99a61D004",
        6,
        Some("usd-coin"),
    ),
    reserve(
        "USDT",
        USDT_ALIASES,
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a",
        "0x6df1C1E379bC5a00a7b4C6e67A203333772f45A8",
        6,
        Some("tether"),
    ),
    reserve(
        "DAI",
        DAI_ALIASES,
        "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        "0x018008bfb33d285247A21d44E50697654f754e63",
        "0xcF8d0c70c850859266f5C338b38F9D663181C314",
        18,
        Some("dai"),
    ),
    reserve(
        "WBTC",
        WBTC_ALIASES,
        "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        "0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8",
        "0x40aAbEf1aa8f0eEc637E0E7d92fbfFB2F26A8b7B",
        8,
        Some("bitcoin"),
    ),
];

const BASE_RESERVES: &[AaveReserve] = &[
    reserve(
        "WETH",
        WETH_ALIASES,
        "0x4200000000000000000000000000000000000006",
        "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7",
        "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E",
        18,
        Some("ethereum"),
    ),
    reserve(
        "USDC",
        USDC_ALIASES,
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
        "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28",
        6,
        Some("usd-coin"),
    ),
    reserve(
        "USDbC",
        USDBC_ALIASES,
        "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
        "0x0a1d576f3eFeF75b330424287a95A366e8281D54",
        "0x7376b2F323dC56fCd4C191B34163ac8a84702DAB",
        6,
        Some("usd-coin"),
    ),
    reserve(
        "cbBTC",
        CBBTC_ALIASES,
        "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
        "0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6",
        "0x05e08702028de6AaD395DC6478b554a56920b9AD",
        8,
        Some("bitcoin"),
    ),
];

const ARBITRUM_RESERVES: &[AaveReserve] = &[
    reserve(
        "WETH",
        WETH_ALIASES,
        "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8",
        "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351",
        18,
        Some("ethereum"),
    ),
    reserve(
        "USDC",
        USDC_ALIASES,
        "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
        "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
        "0xFCCf3cAbbe80101232d343252614b6A3eE81C989",
        6,
        Some("usd-coin"),
    ),
    reserve(
        "USDT",
        USDT_ALIASES,
        "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        "0x6ab707Aca953eDAeFBc4fD23bA73294241490620",
        "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7",
        6,
        Some("tether"),
    ),
    reserve(
        "DAI",
        DAI_ALIASES,
        "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
        "0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE",
        "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC",
        18,
        Some("dai"),
    ),
    reserve(
        "WBTC",
        WBTC_ALIASES,
        "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
        "0x078f358208685046a11C85e8ad32895DED33A249",
        "0x92b42c66840C7AD907b4BF74879FF3eF7c529473",
        8,
        Some("bitcoin"),
    ),
];

const POLYGON_RESERVES: &[AaveReserve] = &[
    reserve(
        "WETH",
        WETH_ALIASES,
        "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8",
        "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351",
        18,
        Some("ethereum"),
    ),
    reserve(
        "USDC",
        USDC_ALIASES,
        "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
        "0xFCCf3cAbbe80101232d343252614b6A3eE81C989",
        6,
        Some("usd-coin"),
    ),
    reserve(
        "DAI",
        DAI_ALIASES,
        "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
        "0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE",
        "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC",
        18,
        Some("dai"),
    ),
    reserve(
        "WBTC",
        WBTC_ALIASES,
        "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
        "0x078f358208685046a11C85e8ad32895DED33A249",
        "0x92b42c66840C7AD907b4BF74879FF3eF7c529473",
        8,
        Some("bitcoin"),
    ),
];

const OPTIMISM_RESERVES: &[AaveReserve] = &[
    reserve(
        "WETH",
        WETH_ALIASES,
        "0x4200000000000000000000000000000000000006",
        "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8",
        "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351",
        18,
        Some("ethereum"),
    ),
    reserve(
        "USDC",
        USDC_ALIASES,
        "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
        "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
        "0xFCCf3cAbbe80101232d343252614b6A3eE81C989",
        6,
        Some("usd-coin"),
    ),
    reserve(
        "USDT",
        USDT_ALIASES,
        "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
        "0x6ab707Aca953eDAeFBc4fD23bA73294241490620",
        "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7",
        6,
        Some("tether"),
    ),
    reserve(
        "DAI",
        DAI_ALIASES,
        "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
        "0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE",
        "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC",
        18,
        Some("dai"),
    ),
    reserve(
        "WBTC",
        WBTC_ALIASES,
        "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
        "0x078f358208685046a11C85e8ad32895DED33A249",
        "0x92b42c66840C7AD907b4BF74879FF3eF7c529473",
        8,
        Some("bitcoin"),
    ),
];

const AVALANCHE_RESERVES: &[AaveReserve] = &[
    reserve(
        "WAVAX",
        WAVAX_ALIASES,
        "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
        "0x6d80113e533a2C0fe82EaBD35f1875DcEA89Ea97",
        "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8",
        18,
        Some("avalanche-2"),
    ),
    reserve(
        "USDC",
        USDC_ALIASES,
        "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
        "0xFCCf3cAbbe80101232d343252614b6A3eE81C989",
        6,
        Some("usd-coin"),
    ),
    reserve(
        "USDt",
        USDT_ALIASES,
        "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
        "0x6ab707Aca953eDAeFBc4fD23bA73294241490620",
        "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7",
        6,
        Some("tether"),
    ),
    reserve(
        "DAIe",
        DAI_ALIASES,
        "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70",
        "0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE",
        "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC",
        18,
        Some("dai"),
    ),
    reserve(
        "WETHe",
        WETH_ALIASES,
        "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
        "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8",
        "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351",
        18,
        Some("ethereum"),
    ),
    reserve(
        "WBTCe",
        WBTC_ALIASES,
        "0x50b7545627a5162F82A992c33b87aDc75187B218",
        "0x078f358208685046a11C85e8ad32895DED33A249",
        "0x92b42c66840C7AD907b4BF74879FF3eF7c529473",
        8,
        Some("bitcoin"),
    ),
];

pub const AAVE_V3_MARKETS: &[AaveMarket] = &[
    AaveMarket {
        chain_id: 1,
        name: "Ethereum mainnet",
        pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
        pool_addresses_provider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
        protocol_data_provider: "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
        reserves: ETHEREUM_RESERVES,
    },
    AaveMarket {
        chain_id: 8453,
        name: "Base",
        pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
        pool_addresses_provider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
        protocol_data_provider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
        reserves: BASE_RESERVES,
    },
    AaveMarket {
        chain_id: 42161,
        name: "Arbitrum",
        pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        pool_addresses_provider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
        protocol_data_provider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
        reserves: ARBITRUM_RESERVES,
    },
    AaveMarket {
        chain_id: 137,
        name: "Polygon",
        pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        pool_addresses_provider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
        protocol_data_provider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
        reserves: POLYGON_RESERVES,
    },
    AaveMarket {
        chain_id: 10,
        name: "Optimism",
        pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        pool_addresses_provider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
        protocol_data_provider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
        reserves: OPTIMISM_RESERVES,
    },
    AaveMarket {
        chain_id: 43114,
        name: "Avalanche",
        pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        pool_addresses_provider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
        protocol_data_provider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
        reserves: AVALANCHE_RESERVES,
    },
];

const fn reserve(
    symbol: &'static str,
    aliases: &'static [&'static str],
    underlying: &'static str,
    a_token: &'static str,
    variable_debt_token: &'static str,
    decimals: u8,
    coingecko_id: Option<&'static str>,
) -> AaveReserve {
    AaveReserve {
        symbol,
        aliases,
        underlying,
        a_token,
        variable_debt_token,
        decimals,
        variable_borrow_enabled: true,
        coingecko_id,
    }
}

pub fn supported_chain_ids() -> Vec<u64> {
    AAVE_V3_MARKETS
        .iter()
        .map(|market| market.chain_id)
        .collect()
}

pub fn market_for_chain(chain_id: u64) -> Option<&'static AaveMarket> {
    AAVE_V3_MARKETS
        .iter()
        .find(|market| market.chain_id == chain_id)
}

pub fn reserve_by_underlying(chain_id: u64, token: &str) -> Option<&'static AaveReserve> {
    let key = normalize_key(token);
    market_for_chain(chain_id)?
        .reserves
        .iter()
        .find(|reserve| normalize_key(reserve.underlying) == key)
}

pub fn reserve_by_a_token(chain_id: u64, token: &str) -> Option<&'static AaveReserve> {
    let key = normalize_key(token);
    market_for_chain(chain_id)?
        .reserves
        .iter()
        .find(|reserve| normalize_key(reserve.a_token) == key)
}

pub fn reserve_by_debt_token(chain_id: u64, token: &str) -> Option<&'static AaveReserve> {
    let key = normalize_key(token);
    market_for_chain(chain_id)?
        .reserves
        .iter()
        .find(|reserve| normalize_key(reserve.variable_debt_token) == key)
}

pub fn reserve_by_symbol(chain_id: u64, symbol: &str) -> Option<&'static AaveReserve> {
    let key = normalize_key(symbol);
    market_for_chain(chain_id)?.reserves.iter().find(|reserve| {
        normalize_key(reserve.symbol) == key
            || reserve
                .aliases
                .iter()
                .any(|alias| normalize_key(alias) == key)
    })
}

pub fn reserve_by_any_token(chain_id: u64, token: &str) -> Option<&'static AaveReserve> {
    reserve_by_underlying(chain_id, token)
        .or_else(|| reserve_by_a_token(chain_id, token))
        .or_else(|| reserve_by_debt_token(chain_id, token))
}

fn normalize_key(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_market_has_addresses_and_reserves() {
        for market in AAVE_V3_MARKETS {
            assert!(market.pool.starts_with("0x"));
            assert!(market.pool_addresses_provider.starts_with("0x"));
            assert!(market.protocol_data_provider.starts_with("0x"));
            assert!(!market.reserves.is_empty());
            for reserve in market.reserves {
                assert!(reserve.underlying.starts_with("0x"));
                assert!(reserve.a_token.starts_with("0x"));
                assert!(reserve.variable_debt_token.starts_with("0x"));
                assert!(reserve.decimals > 0);
            }
        }
    }

    #[test]
    fn resolves_underlying_wrappers_and_debt_tokens() {
        let base_usdc = reserve_by_symbol(8453, "USDC").expect("base usdc");
        assert_eq!(
            reserve_by_underlying(8453, base_usdc.underlying),
            Some(base_usdc)
        );
        assert_eq!(reserve_by_a_token(8453, base_usdc.a_token), Some(base_usdc));
        assert_eq!(
            reserve_by_debt_token(8453, base_usdc.variable_debt_token),
            Some(base_usdc)
        );
    }
}
