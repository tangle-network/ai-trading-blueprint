//! Pre-flight simulator — spins up an Anvil fork, executes the envelope's
//! `target.call{value}(data)` against the fork, and returns a structured
//! `PreflightResult` so operators can fail fast *before* paying gas for an
//! on-chain revert.
//!
//! Unlike `EthCallSimulator` (which is stateless and best-effort), this
//! module:
//!
//! 1. Spawns a forked Anvil at a known block (via `alloy::node_bindings`).
//! 2. Optionally impersonates the vault, funds it with ETH, and simulates
//!    state preconditions before the actual call.
//! 3. Executes the call as a real transaction on the fork — so any state
//!    transitions (Aave deposits, Uniswap swaps, etc.) are observed exactly
//!    as they would be on mainnet.
//! 4. Reads token balances (`balanceOf`) before/after to derive
//!    `predicted_output`.
//! 5. When Aave parameters are supplied, calls `pool.getUserAccountData`
//!    on the post-state and returns the predicted health factor (1e18 wad).
//!
//! Critically, this is a *defense-in-depth + UX win*: when the pre-flight
//! reports `pass=false` with a structured `reason`, the operator skips the
//! on-chain submission and avoids burning gas on a guaranteed revert.

use std::time::Duration;

use alloy::network::{Ethereum, EthereumWallet};
use alloy::node_bindings::{Anvil, AnvilInstance};
use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::fillers::{
    BlobGasFiller, ChainIdFiller, FillProvider, GasFiller, JoinFill, NonceFiller, WalletFiller,
};
use alloy::providers::{Identity, Provider, ProviderBuilder, RootProvider};
use alloy::rpc::types::TransactionRequest;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::SolCall;
use serde::{Deserialize, Serialize};

use crate::error::TradingError;

sol! {
    function balanceOf(address account) external view returns (uint256);
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
}

/// Default block-time for Anvil fork instances (no auto-mining beyond
/// explicit transactions). We mine on-demand via the wallet provider.
const DEFAULT_FORK_TIMEOUT_SECS: u64 = 60;

/// Optional Aave context for predicting the post-call health factor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AaveHealthContext {
    /// Aave V3 Pool contract address on the target chain.
    pub pool: Address,
    /// Account whose health factor we want to predict (typically the vault).
    pub account: Address,
}

/// Pre-flight simulation request.
///
/// Mirrors the on-chain `target.call{value}(data)` semantics emitted by the
/// vault when executing an envelope. `output_token` + `min_output` let the
/// simulator detect slippage failures without running the validator path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightRequest {
    /// Target chain ID — must match the `--fork-url` RPC's chain.
    pub chain_id: u64,
    /// Trading vault address (the account that issues the call on-chain).
    pub vault: Address,
    /// External target the vault is calling (DEX router, lending pool, etc.).
    pub target: Address,
    /// ETH value (wei) sent with the call.
    pub value: U256,
    /// ABI-encoded calldata for the target.
    pub data: Bytes,
    /// Token whose post-call balance delta we measure (the envelope's
    /// declared output token). When `Address::ZERO`, the simulator skips
    /// the balance delta and only reports `pass`/`gas_estimate`.
    pub output_token: Address,
    /// Minimum acceptable output (in `output_token` base units). When the
    /// observed delta is below this, the result is marked `pass=false`
    /// with an `OutputBelowMinimum` reason.
    pub min_output: U256,
    /// Optional Aave V3 context — when supplied, the post-call health
    /// factor is included in the result.
    #[serde(default)]
    pub aave: Option<AaveHealthContext>,
    /// Optional fork block number — pin for determinism. Falls back to
    /// the RPC's head block when `None`.
    #[serde(default)]
    pub fork_block: Option<u64>,
}

/// Structured pre-flight outcome.
///
/// `pass=true` means the call succeeded *and* (when applicable) the
/// observed output beat `min_output`. Any other outcome populates `reason`
/// with a machine-readable string so operators can route on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightResult {
    /// Overall pass/fail.
    pub pass: bool,
    /// Output-token balance delta on the vault, measured pre vs post call.
    /// Zero when no `output_token` was supplied or the call failed.
    pub predicted_output: U256,
    /// Aave V3 health factor (wad-scaled, 1e18 = 1.0). `None` when no
    /// Aave context was supplied or the lookup failed.
    pub predicted_health_factor: Option<U256>,
    /// Gas consumed by the simulated call (post-execution receipt).
    pub gas_estimate: u64,
    /// Machine-readable failure reason. `None` on success.
    pub reason: Option<String>,
    /// Balance of `output_token` on `vault` *before* the call.
    pub balance_before: U256,
    /// Balance of `output_token` on `vault` *after* the call.
    pub balance_after: U256,
}

impl PreflightResult {
    /// Build a structured failure result. `pass=false`, no balance delta,
    /// gas zero.
    fn failure(reason: impl Into<String>) -> Self {
        Self {
            pass: false,
            predicted_output: U256::ZERO,
            predicted_health_factor: None,
            gas_estimate: 0,
            reason: Some(reason.into()),
            balance_before: U256::ZERO,
            balance_after: U256::ZERO,
        }
    }
}

/// Configuration for the pre-flight simulator.
#[derive(Debug, Clone)]
pub struct PreflightConfig {
    /// Upstream RPC URL used as `--fork-url`. When `None`, the simulator
    /// returns `SimulationUnavailable` — pre-flight is opt-in and degrades
    /// gracefully when the operator has no fork target configured.
    pub fork_rpc_url: Option<String>,
    /// Hard timeout for the entire pre-flight (Anvil spawn + tx exec).
    pub timeout: Duration,
    /// Path to the `anvil` binary. `None` lets `alloy::node_bindings` auto-detect.
    pub anvil_path: Option<String>,
}

impl Default for PreflightConfig {
    fn default() -> Self {
        Self {
            fork_rpc_url: std::env::var("PREFLIGHT_FORK_RPC_URL")
                .ok()
                .filter(|v| !v.is_empty()),
            timeout: Duration::from_secs(
                std::env::var("PREFLIGHT_TIMEOUT_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_FORK_TIMEOUT_SECS),
            ),
            anvil_path: std::env::var("PREFLIGHT_ANVIL_PATH").ok(),
        }
    }
}

impl PreflightConfig {
    /// Builder shortcut — explicit URL overrides env config.
    pub fn with_rpc_url(mut self, url: impl Into<String>) -> Self {
        self.fork_rpc_url = Some(url.into());
        self
    }
}

/// Type alias mirroring `chain::HttpProvider` but for the throwaway fork.
type ForkProvider = FillProvider<
    JoinFill<
        JoinFill<
            Identity,
            JoinFill<GasFiller, JoinFill<BlobGasFiller, JoinFill<NonceFiller, ChainIdFiller>>>,
        >,
        WalletFiller<EthereumWallet>,
    >,
    RootProvider<Ethereum>,
    Ethereum,
>;

/// Pre-flight simulator. Holds config; each `run` call spawns a fresh fork.
pub struct PreflightSimulator {
    config: PreflightConfig,
}

impl PreflightSimulator {
    pub fn new(config: PreflightConfig) -> Self {
        Self { config }
    }

    /// Convenience: load config from env vars. See `PreflightConfig::default`.
    pub fn from_env() -> Self {
        Self::new(PreflightConfig::default())
    }

    /// Run a pre-flight simulation and return the structured result.
    ///
    /// On infrastructure failure (no RPC URL, anvil not on PATH, etc.) this
    /// returns `Err(TradingError::SimulationUnavailable)` so callers can
    /// distinguish "the trade is bad" from "we couldn't tell".
    pub async fn run(&self, request: PreflightRequest) -> Result<PreflightResult, TradingError> {
        let rpc_url = self.config.fork_rpc_url.as_ref().ok_or_else(|| {
            TradingError::SimulationUnavailable(
                "PREFLIGHT_FORK_RPC_URL is not configured".to_string(),
            )
        })?;

        let fut = self.run_inner(rpc_url, &request);
        match tokio::time::timeout(self.config.timeout, fut).await {
            Ok(result) => result,
            Err(_) => Err(TradingError::Timeout(format!(
                "preflight simulation exceeded {}s",
                self.config.timeout.as_secs()
            ))),
        }
    }

    async fn run_inner(
        &self,
        rpc_url: &str,
        request: &PreflightRequest,
    ) -> Result<PreflightResult, TradingError> {
        let _anvil = self.spawn_fork(rpc_url, request)?;
        let endpoint = _anvil.endpoint();
        tracing::debug!(endpoint, fork_url = rpc_url, "Anvil fork spawned");

        // The first key Anvil issues is fully funded — use it for the wallet
        // that signs anvil_* admin calls. The vault impersonation handles the
        // actual call submission.
        let signer: PrivateKeySigner = _anvil.keys()[0].clone().into();
        let wallet = EthereumWallet::from(signer);
        let url: url::Url = endpoint
            .parse()
            .map_err(|e| TradingError::ConfigError(format!("invalid anvil endpoint: {e}")))?;
        let provider: ForkProvider = ProviderBuilder::new()
            .wallet(wallet)
            .connect_http(url.clone());

        // 1. Verify chain ID matches the request — guards against a misconfigured
        //    fork URL silently simulating on the wrong chain.
        let observed_chain = provider
            .get_chain_id()
            .await
            .map_err(|e| TradingError::HttpError(format!("eth_chainId failed: {e}")))?;
        if observed_chain != request.chain_id {
            return Ok(PreflightResult::failure(format!(
                "chain mismatch: fork has chain_id={observed_chain}, request expects {}",
                request.chain_id
            )));
        }

        // 2. Fund the vault with enough ETH to pay gas + cover `value`.
        let vault_funding = request
            .value
            .saturating_add(U256::from(10u64).pow(U256::from(18u64)));
        anvil_set_balance(&provider, request.vault, vault_funding).await?;

        // 3. Impersonate the vault so we can issue `target.call{value}(data)`
        //    from its address — matching production semantics.
        anvil_impersonate(&provider, request.vault).await?;

        // 4. Snapshot pre-call balance (best-effort — `balanceOf` reverts on
        //    non-ERC20 targets, in which case we record zero).
        let balance_before = if request.output_token != Address::ZERO {
            query_balance(&provider, request.output_token, request.vault)
                .await
                .unwrap_or(U256::ZERO)
        } else {
            U256::ZERO
        };

        // 5. Execute the call.
        let exec_result = self.execute_call(&provider, request).await;

        // 6. Stop impersonation regardless of execution outcome.
        let _ = anvil_stop_impersonating(&provider, request.vault).await;

        let (gas_used, exec_reason) = match exec_result {
            Ok(gas) => (gas, None),
            Err(reason) => {
                return Ok(PreflightResult {
                    pass: false,
                    predicted_output: U256::ZERO,
                    predicted_health_factor: None,
                    gas_estimate: 0,
                    reason: Some(reason),
                    balance_before,
                    balance_after: balance_before,
                });
            }
        };

        // 7. Snapshot post-call balance and compute delta.
        let balance_after = if request.output_token != Address::ZERO {
            query_balance(&provider, request.output_token, request.vault)
                .await
                .unwrap_or(balance_before)
        } else {
            balance_before
        };

        let predicted_output = balance_after.saturating_sub(balance_before);

        // 8. Optional Aave health factor lookup.
        let predicted_health_factor = if let Some(aave) = &request.aave {
            query_health_factor(&provider, aave.pool, aave.account)
                .await
                .ok()
        } else {
            None
        };

        // 9. Slippage guard.
        let mut reason = exec_reason;
        let mut pass = true;
        if request.output_token != Address::ZERO
            && request.min_output > U256::ZERO
            && predicted_output < request.min_output
        {
            pass = false;
            reason = Some(format!(
                "OutputBelowMinimum: predicted={predicted_output} min={}",
                request.min_output
            ));
        }

        Ok(PreflightResult {
            pass,
            predicted_output,
            predicted_health_factor,
            gas_estimate: gas_used,
            reason,
            balance_before,
            balance_after,
        })
    }

    /// Spawn the fork with the configured args. Errors here are
    /// infrastructure-level (anvil missing, RPC unreachable) and bubble up as
    /// `SimulationUnavailable`.
    fn spawn_fork(
        &self,
        rpc_url: &str,
        request: &PreflightRequest,
    ) -> Result<AnvilInstance, TradingError> {
        let mut builder = Anvil::new().fork(rpc_url);
        if let Some(block) = request.fork_block {
            builder = builder.fork_block_number(block);
        }
        if let Some(path) = &self.config.anvil_path {
            builder = builder.path(path);
        }
        builder.try_spawn().map_err(|e| {
            TradingError::SimulationUnavailable(format!("failed to spawn anvil fork: {e}"))
        })
    }

    /// Issue the `target.call{value}(data)` from the impersonated vault and
    /// return the gas used. Bubbles a string reason on revert/timeout for
    /// the caller to surface as `PreflightResult::reason`.
    async fn execute_call(
        &self,
        provider: &ForkProvider,
        request: &PreflightRequest,
    ) -> Result<u64, String> {
        let tx = TransactionRequest::default()
            .from(request.vault)
            .to(request.target)
            .value(request.value)
            .input(request.data.clone().into());

        let pending = provider
            .send_transaction(tx)
            .await
            .map_err(|e| format!("send_transaction failed: {e}"))?;

        let receipt = pending
            .get_receipt()
            .await
            .map_err(|e| format!("get_receipt failed: {e}"))?;

        if !receipt.status() {
            return Err(format!(
                "ExecutionReverted: tx {} reverted on fork",
                receipt.transaction_hash
            ));
        }

        Ok(receipt.gas_used)
    }
}

/// Call `anvil_setBalance` to fund an account on the fork.
async fn anvil_set_balance(
    provider: &ForkProvider,
    account: Address,
    balance: U256,
) -> Result<(), TradingError> {
    let _: () = provider
        .raw_request(
            "anvil_setBalance".into(),
            (account, format!("0x{balance:x}")),
        )
        .await
        .map_err(|e| TradingError::HttpError(format!("anvil_setBalance failed: {e}")))?;
    Ok(())
}

async fn anvil_impersonate(provider: &ForkProvider, account: Address) -> Result<(), TradingError> {
    let _: () = provider
        .raw_request("anvil_impersonateAccount".into(), (account,))
        .await
        .map_err(|e| TradingError::HttpError(format!("anvil_impersonateAccount failed: {e}")))?;
    Ok(())
}

async fn anvil_stop_impersonating(
    provider: &ForkProvider,
    account: Address,
) -> Result<(), TradingError> {
    let _: () = provider
        .raw_request("anvil_stopImpersonatingAccount".into(), (account,))
        .await
        .map_err(|e| {
            TradingError::HttpError(format!("anvil_stopImpersonatingAccount failed: {e}"))
        })?;
    Ok(())
}

/// Query ERC20 `balanceOf(account)` via `eth_call` on the fork.
async fn query_balance(
    provider: &ForkProvider,
    token: Address,
    account: Address,
) -> Result<U256, TradingError> {
    let calldata = balanceOfCall { account }.abi_encode();
    let tx = TransactionRequest::default()
        .to(token)
        .input(Bytes::from(calldata).into());
    let bytes = provider
        .call(tx)
        .await
        .map_err(|e| TradingError::HttpError(format!("balanceOf eth_call failed: {e}")))?;
    if bytes.len() < 32 {
        return Ok(U256::ZERO);
    }
    Ok(U256::from_be_slice(&bytes[..32]))
}

/// Query the Aave V3 pool's `getUserAccountData(user)` and return the
/// health factor (1e18-wad). Errors are propagated so the caller can decide
/// whether to surface or swallow them — `PreflightSimulator::run_inner`
/// chooses the latter (best-effort, default `None`).
async fn query_health_factor(
    provider: &ForkProvider,
    pool: Address,
    user: Address,
) -> Result<U256, TradingError> {
    let calldata = getUserAccountDataCall { user }.abi_encode();
    let tx = TransactionRequest::default()
        .to(pool)
        .input(Bytes::from(calldata).into());
    let bytes = provider
        .call(tx)
        .await
        .map_err(|e| TradingError::HttpError(format!("getUserAccountData failed: {e}")))?;
    let decoded = getUserAccountDataCall::abi_decode_returns(&bytes)
        .map_err(|e| TradingError::SerializationError(format!("decode getUserAccountData: {e}")))?;
    Ok(decoded.healthFactor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_request() -> PreflightRequest {
        PreflightRequest {
            chain_id: 1,
            vault: Address::with_last_byte(0x42),
            target: Address::with_last_byte(0x99),
            value: U256::ZERO,
            data: Bytes::from_static(&[0xde, 0xad, 0xbe, 0xef]),
            output_token: Address::with_last_byte(0x10),
            min_output: U256::from(1_000u64),
            aave: None,
            fork_block: Some(19_000_000),
        }
    }

    #[test]
    fn preflight_request_round_trip() {
        let req = dummy_request();
        let json = serde_json::to_string(&req).unwrap();
        let decoded: PreflightRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.chain_id, req.chain_id);
        assert_eq!(decoded.vault, req.vault);
        assert_eq!(decoded.target, req.target);
        assert_eq!(decoded.min_output, req.min_output);
        assert_eq!(decoded.fork_block, req.fork_block);
    }

    #[test]
    fn preflight_result_round_trip() {
        let result = PreflightResult {
            pass: true,
            predicted_output: U256::from(2_500_000_000u64),
            predicted_health_factor: Some(U256::from(1_500_000_000_000_000_000u128)),
            gas_estimate: 220_000,
            reason: None,
            balance_before: U256::from(0u64),
            balance_after: U256::from(2_500_000_000u64),
        };
        let json = serde_json::to_string(&result).unwrap();
        let decoded: PreflightResult = serde_json::from_str(&json).unwrap();
        assert!(decoded.pass);
        assert_eq!(decoded.predicted_output, result.predicted_output);
        assert_eq!(
            decoded.predicted_health_factor,
            result.predicted_health_factor
        );
    }

    #[test]
    fn preflight_failure_helper() {
        let r = PreflightResult::failure("nope");
        assert!(!r.pass);
        assert_eq!(r.predicted_output, U256::ZERO);
        assert_eq!(r.gas_estimate, 0);
        assert_eq!(r.reason.as_deref(), Some("nope"));
    }

    #[test]
    fn config_default_picks_up_env() {
        // Snapshot + restore so we don't pollute sibling tests.
        let prev = std::env::var("PREFLIGHT_FORK_RPC_URL").ok();
        // SAFETY: tests run sequentially within this module via the default
        // single-threaded test runtime, but std::env::set_var is unsafe in
        // 2024 edition because background threads can race. We only mutate
        // here, snapshot first, and restore at the end.
        unsafe {
            std::env::set_var("PREFLIGHT_FORK_RPC_URL", "https://example.test/rpc");
        }
        let config = PreflightConfig::default();
        assert_eq!(
            config.fork_rpc_url.as_deref(),
            Some("https://example.test/rpc")
        );
        unsafe {
            match prev {
                Some(v) => std::env::set_var("PREFLIGHT_FORK_RPC_URL", v),
                None => std::env::remove_var("PREFLIGHT_FORK_RPC_URL"),
            }
        }
    }

    #[test]
    fn config_with_rpc_url_overrides_env() {
        let cfg = PreflightConfig::default().with_rpc_url("http://localhost:8545");
        assert_eq!(cfg.fork_rpc_url.as_deref(), Some("http://localhost:8545"));
    }

    #[tokio::test]
    async fn run_without_rpc_returns_unavailable() {
        // Ensure env is not set so default produces None.
        let prev = std::env::var("PREFLIGHT_FORK_RPC_URL").ok();
        unsafe {
            std::env::remove_var("PREFLIGHT_FORK_RPC_URL");
        }
        let sim = PreflightSimulator::new(PreflightConfig::default());
        let err = sim.run(dummy_request()).await.unwrap_err();
        assert!(
            matches!(err, TradingError::SimulationUnavailable(_)),
            "expected SimulationUnavailable, got {err:?}"
        );
        unsafe {
            if let Some(v) = prev {
                std::env::set_var("PREFLIGHT_FORK_RPC_URL", v);
            }
        }
    }
}
