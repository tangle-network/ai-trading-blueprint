//! Pre-provision checks for user-selected DEX assets.
//!
//! The frontend uses this before adding a manually entered token address to a
//! bot's asset universe. Provisioning still performs the authoritative on-chain
//! configuration, but this gives users an early, clear failure.

use alloy::primitives::{Address, Bytes, Uint};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::sol;
use alloy::sol_types::SolCall;
use serde::{Deserialize, Serialize};
use trading_runtime::contracts::{IAssetValuator, IUniswapV3TwapValuator};

type Uint24 = Uint<24, 1>;

sol! {
    #[sol(rpc)]
    interface IERC20Metadata {
        function symbol() external view returns (string memory);
        function name() external view returns (string memory);
        function decimals() external view returns (uint8);
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DexAssetPreflightRequest {
    pub chain_id: u64,
    pub rpc_url: String,
    pub token_address: String,
    pub base_asset: String,
    #[serde(default)]
    pub strategy_type: Option<String>,
    #[serde(default)]
    pub protocol: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DexAssetPreflightResponse {
    pub ok: bool,
    pub chain_id: u64,
    pub token_address: String,
    pub base_asset: String,
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub decimals: Option<u8>,
    pub valuation_source: Option<String>,
    pub valuation_adapter: Option<String>,
    pub selected_fee_tier: Option<u32>,
    pub warnings: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
struct TokenMetadata {
    symbol: Option<String>,
    name: Option<String>,
    decimals: u8,
}

#[derive(Debug, Clone)]
struct TwapConfig {
    fee_tiers: Vec<u32>,
    twap_window: u32,
    min_harmonic_liquidity: u128,
    max_spot_twap_deviation_bps: u32,
}

pub async fn preflight_dex_asset(
    request: DexAssetPreflightRequest,
) -> Result<DexAssetPreflightResponse, String> {
    let token = parse_non_zero_address(&request.token_address, "token_address")?;
    let base_asset = parse_non_zero_address(&request.base_asset, "base_asset")?;
    let rpc_url = resolve_preflight_rpc_url(&request)?;

    let provider = ProviderBuilder::new().connect_http(
        rpc_url
            .parse()
            .map_err(|e| format!("invalid rpc_url for asset preflight: {e}"))?,
    );
    let metadata = read_erc20_metadata(&provider, token).await?;
    let mut warnings = Vec::new();
    if metadata.symbol.is_none() {
        warnings.push("Token does not expose a standard ERC20 symbol; the UI will use the address as a fallback.".to_string());
    }
    if metadata.name.is_none() {
        warnings.push("Token does not expose a standard ERC20 name.".to_string());
    }

    if token == base_asset {
        return Ok(success_response(
            &request,
            token,
            base_asset,
            metadata,
            "base_asset",
            "none",
            None,
            warnings,
        ));
    }

    if let Some(chainlink_adapter) = valuation_adapter_address_from_env(&[
        "CHAINLINK_USD_VALUATOR_ADDRESS",
        "EXECUTION_CHAINLINK_USD_VALUATOR",
        "CHAINLINK_VALUATOR_ADDRESS",
        "DEPLOY_CHAINLINK_USD_VALUATOR",
    ]) {
        match adapter_supports(&provider, chainlink_adapter, token, base_asset).await {
            Ok(true) => {
                return Ok(success_response(
                    &request,
                    token,
                    base_asset,
                    metadata,
                    "chainlink",
                    "chainlink_usd",
                    None,
                    warnings,
                ));
            }
            Ok(false) => {}
            Err(err) => warnings.push(format!("Chainlink support check failed: {err}")),
        }
    }

    let Some(twap_adapter) = valuation_adapter_address_from_env(&[
        "UNISWAP_V3_TWAP_VALUATOR_ADDRESS",
        "EXECUTION_UNISWAP_V3_TWAP_VALUATOR",
        "DEPLOY_UNISWAP_V3_TWAP_VALUATOR",
    ]) else {
        return Ok(failure_response(
            &request,
            token,
            base_asset,
            metadata,
            warnings,
            "No Chainlink feed is available and no Uniswap V3 TWAP valuator is configured.",
        ));
    };

    let config = twap_config_from_env();
    match preview_best_twap_pool(&provider, twap_adapter, token, base_asset, &config).await {
        Ok(Some(fee_tier)) => Ok(success_response(
            &request,
            token,
            base_asset,
            metadata,
            "uniswap_v3_twap",
            "chainlink_or_uniswap_v3_twap",
            Some(fee_tier),
            warnings,
        )),
        Ok(None) => Ok(failure_response(
            &request,
            token,
            base_asset,
            metadata,
            warnings,
            "No direct Uniswap V3 TWAP pool is available against the selected base asset.",
        )),
        Err(err) => Ok(failure_response(
            &request,
            token,
            base_asset,
            metadata,
            warnings,
            &format!("Uniswap V3 TWAP check failed: {err}"),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn success_response(
    request: &DexAssetPreflightRequest,
    token: Address,
    base_asset: Address,
    metadata: TokenMetadata,
    source: &str,
    adapter: &str,
    fee_tier: Option<u32>,
    warnings: Vec<String>,
) -> DexAssetPreflightResponse {
    DexAssetPreflightResponse {
        ok: true,
        chain_id: request.chain_id,
        token_address: format!("{token:#x}"),
        base_asset: format!("{base_asset:#x}"),
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: Some(metadata.decimals),
        valuation_source: Some(source.to_string()),
        valuation_adapter: Some(adapter.to_string()),
        selected_fee_tier: fee_tier,
        warnings,
        message: None,
    }
}

fn failure_response(
    request: &DexAssetPreflightRequest,
    token: Address,
    base_asset: Address,
    metadata: TokenMetadata,
    warnings: Vec<String>,
    message: &str,
) -> DexAssetPreflightResponse {
    DexAssetPreflightResponse {
        ok: false,
        chain_id: request.chain_id,
        token_address: format!("{token:#x}"),
        base_asset: format!("{base_asset:#x}"),
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: Some(metadata.decimals),
        valuation_source: None,
        valuation_adapter: None,
        selected_fee_tier: None,
        warnings,
        message: Some(message.to_string()),
    }
}

fn parse_non_zero_address(raw: &str, field: &str) -> Result<Address, String> {
    let address = raw
        .trim()
        .parse::<Address>()
        .map_err(|e| format!("invalid {field}: {e}"))?;
    if address == Address::ZERO {
        return Err(format!("{field} must not be zero"));
    }
    Ok(address)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreflightRpcCandidate {
    chain_id: Option<u64>,
    rpc_url: String,
}

fn resolve_preflight_rpc_url(request: &DexAssetPreflightRequest) -> Result<String, String> {
    let mut candidates = preflight_rpc_candidates_from_env(request.chain_id);
    candidates.retain(|candidate| !candidate.rpc_url.trim().is_empty());

    select_preflight_rpc_url(&candidates, request.chain_id, request.rpc_url.trim()).ok_or_else(
        || {
            "asset preflight RPC is not configured for this chain; configure DEX_ASSET_PREFLIGHT_RPC_URLS or a matching trusted RPC_URL"
                .to_string()
        },
    )
}

fn preflight_rpc_candidates_from_env(chain_id: u64) -> Vec<PreflightRpcCandidate> {
    let mut candidates = Vec::new();

    for name in [
        "DEX_ASSET_PREFLIGHT_RPC_URLS",
        "DEX_ASSET_PREFLIGHT_RPC_ALLOWLIST",
    ] {
        if let Ok(raw) = std::env::var(name) {
            candidates.extend(parse_preflight_rpc_candidates(&raw));
        }
    }

    for name in [
        format!("DEX_ASSET_PREFLIGHT_RPC_URL_{chain_id}"),
        format!("EXECUTION_RPC_URL_{chain_id}"),
        format!("RPC_URL_{chain_id}"),
    ] {
        if let Ok(raw) = std::env::var(name) {
            candidates.push(PreflightRpcCandidate {
                chain_id: Some(chain_id),
                rpc_url: raw.trim().to_string(),
            });
        }
    }

    if let Ok(raw) = std::env::var("RPC_URL")
        && trusted_env_chain_matches(chain_id)
    {
        candidates.push(PreflightRpcCandidate {
            chain_id: Some(chain_id),
            rpc_url: raw.trim().to_string(),
        });
    }

    candidates
}

fn parse_preflight_rpc_candidates(raw: &str) -> Vec<PreflightRpcCandidate> {
    raw.split([',', '\n'])
        .filter_map(|entry| parse_preflight_rpc_candidate(entry.trim()))
        .collect()
}

fn parse_preflight_rpc_candidate(entry: &str) -> Option<PreflightRpcCandidate> {
    if entry.is_empty() {
        return None;
    }

    if let Some((chain, rpc_url)) = entry.split_once('=')
        && let Ok(chain_id) = chain.trim().parse()
    {
        return Some(PreflightRpcCandidate {
            chain_id: Some(chain_id),
            rpc_url: rpc_url.trim().to_string(),
        });
    }

    Some(PreflightRpcCandidate {
        chain_id: None,
        rpc_url: entry.to_string(),
    })
}

fn trusted_env_chain_matches(chain_id: u64) -> bool {
    trusted_env_chain_id()
        .map(|configured| configured == chain_id)
        .unwrap_or(true)
}

fn trusted_env_chain_id() -> Option<u64> {
    [
        "EXECUTION_CHAIN_ID",
        "PROTOCOL_CHAIN_ID",
        "FORK_BASE_CHAIN_ID",
        "CHAIN_ID",
    ]
    .iter()
    .find_map(|name| std::env::var(name).ok())
    .and_then(|value| value.trim().parse().ok())
}

fn select_preflight_rpc_url(
    candidates: &[PreflightRpcCandidate],
    chain_id: u64,
    requested_rpc_url: &str,
) -> Option<String> {
    let matching_candidates = candidates
        .iter()
        .filter(|candidate| candidate.chain_id.is_none_or(|id| id == chain_id))
        .collect::<Vec<_>>();

    if !requested_rpc_url.is_empty()
        && matching_candidates
            .iter()
            .any(|candidate| candidate.rpc_url == requested_rpc_url)
    {
        return Some(requested_rpc_url.to_string());
    }

    match matching_candidates.as_slice() {
        [candidate] => Some(candidate.rpc_url.clone()),
        _ => None,
    }
}

async fn read_erc20_metadata<P>(provider: &P, token: Address) -> Result<TokenMetadata, String>
where
    P: Provider,
{
    let decimals_call = IERC20Metadata::decimalsCall {};
    let decimals_bytes = provider
        .call(
            alloy::rpc::types::TransactionRequest::default()
                .to(token)
                .input(Bytes::from(decimals_call.abi_encode()).into()),
        )
        .await
        .map_err(|e| format!("{token:#x} is not a readable ERC20 token: {e}"))?;
    let decimals = IERC20Metadata::decimalsCall::abi_decode_returns(&decimals_bytes)
        .map_err(|e| format!("{token:#x} does not expose ERC20 decimals(): {e}"))?;

    let symbol = read_symbol(provider, token)
        .await
        .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    let name = read_name(provider, token)
        .await
        .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));

    Ok(TokenMetadata {
        symbol,
        name,
        decimals,
    })
}

async fn read_symbol<P>(provider: &P, token: Address) -> Option<String>
where
    P: Provider,
{
    let data = IERC20Metadata::symbolCall {}.abi_encode();
    let bytes = provider
        .call(
            alloy::rpc::types::TransactionRequest::default()
                .to(token)
                .input(Bytes::from(data).into()),
        )
        .await
        .ok()?;
    IERC20Metadata::symbolCall::abi_decode_returns(&bytes).ok()
}

async fn read_name<P>(provider: &P, token: Address) -> Option<String>
where
    P: Provider,
{
    let data = IERC20Metadata::nameCall {}.abi_encode();
    let bytes = provider
        .call(
            alloy::rpc::types::TransactionRequest::default()
                .to(token)
                .input(Bytes::from(data).into()),
        )
        .await
        .ok()?;
    IERC20Metadata::nameCall::abi_decode_returns(&bytes).ok()
}

async fn adapter_supports<P>(
    provider: &P,
    adapter: Address,
    token: Address,
    base_asset: Address,
) -> Result<bool, String>
where
    P: Provider,
{
    let call = IAssetValuator::isSupportedCall {
        token,
        asset: base_asset,
    };
    let bytes = provider
        .call(
            alloy::rpc::types::TransactionRequest::default()
                .to(adapter)
                .input(Bytes::from(call.abi_encode()).into()),
        )
        .await
        .map_err(|e| format!("adapter {adapter:#x} support call failed: {e}"))?;
    IAssetValuator::isSupportedCall::abi_decode_returns(&bytes)
        .map_err(|e| format!("adapter {adapter:#x} support response decode failed: {e}"))
}

async fn preview_best_twap_pool<P>(
    provider: &P,
    adapter: Address,
    token: Address,
    base_asset: Address,
    config: &TwapConfig,
) -> Result<Option<u32>, String>
where
    P: Provider,
{
    let mut best_fee = None;
    let mut best_liquidity = 0u128;

    for fee in &config.fee_tiers {
        let Ok(fee_tier) = Uint24::try_from(*fee) else {
            continue;
        };
        let call = IUniswapV3TwapValuator::previewPoolCall {
            token,
            asset: base_asset,
            fee: fee_tier,
            twapWindow: config.twap_window,
            minHarmonicLiquidity: config.min_harmonic_liquidity,
            maxSpotTwapDeviationBps: config.max_spot_twap_deviation_bps,
        };
        let Ok(bytes) = provider
            .call(
                alloy::rpc::types::TransactionRequest::default()
                    .to(adapter)
                    .input(Bytes::from(call.abi_encode()).into()),
            )
            .await
        else {
            continue;
        };
        let Ok(preview) = IUniswapV3TwapValuator::previewPoolCall::abi_decode_returns(&bytes)
        else {
            continue;
        };
        if preview.harmonicMeanLiquidity > best_liquidity {
            best_liquidity = preview.harmonicMeanLiquidity;
            best_fee = Some(*fee);
        }
    }

    Ok(best_fee)
}

fn valuation_adapter_address_from_env(names: &[&str]) -> Option<Address> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse().ok())
}

fn env_u32(names: &[&str], default: u32) -> u32 {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn env_u128(names: &[&str], default: u128) -> u128 {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn twap_fee_tiers_from_env() -> Vec<u32> {
    std::env::var("UNISWAP_V3_TWAP_FEE_TIERS")
        .or_else(|_| std::env::var("EXECUTION_UNISWAP_V3_TWAP_FEE_TIERS"))
        .unwrap_or_else(|_| "500,3000,10000".to_string())
        .split(',')
        .filter_map(|value| value.trim().parse().ok())
        .collect()
}

fn twap_config_from_env() -> TwapConfig {
    TwapConfig {
        fee_tiers: twap_fee_tiers_from_env(),
        twap_window: env_u32(
            &[
                "UNISWAP_V3_TWAP_WINDOW_SECS",
                "EXECUTION_UNISWAP_V3_TWAP_WINDOW_SECS",
            ],
            1_800,
        ),
        min_harmonic_liquidity: env_u128(
            &[
                "UNISWAP_V3_TWAP_MIN_HARMONIC_LIQUIDITY",
                "EXECUTION_UNISWAP_V3_TWAP_MIN_HARMONIC_LIQUIDITY",
            ],
            1,
        ),
        max_spot_twap_deviation_bps: env_u32(
            &[
                "UNISWAP_V3_TWAP_MAX_SPOT_DEVIATION_BPS",
                "EXECUTION_UNISWAP_V3_TWAP_MAX_SPOT_DEVIATION_BPS",
            ],
            500,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_exact_requested_rpc_from_allowlist() {
        let candidates = parse_preflight_rpc_candidates(
            "1=https://ethereum-rpc.publicnode.com,31339=http://127.0.0.1:42545",
        );

        let selected =
            select_preflight_rpc_url(&candidates, 31339, "http://127.0.0.1:42545").unwrap();

        assert_eq!(selected, "http://127.0.0.1:42545");
    }

    #[test]
    fn ignores_untrusted_requested_rpc_when_single_trusted_rpc_exists() {
        let candidates = parse_preflight_rpc_candidates("31339=http://127.0.0.1:42545");

        let selected =
            select_preflight_rpc_url(&candidates, 31339, "http://169.254.169.254/latest").unwrap();

        assert_eq!(selected, "http://127.0.0.1:42545");
    }

    #[test]
    fn rejects_untrusted_requested_rpc_when_allowlist_has_multiple_matches() {
        let candidates = parse_preflight_rpc_candidates(
            "31339=http://127.0.0.1:42545,31339=http://127.0.0.1:42546",
        );

        let selected =
            select_preflight_rpc_url(&candidates, 31339, "http://169.254.169.254/latest");

        assert!(selected.is_none());
    }
}
