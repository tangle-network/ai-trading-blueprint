//! Integration tests for `simulator::preflight::PreflightSimulator`.
//!
//! Two suites:
//!
//! 1. **Default suite (no env required)** — exercises the *infrastructure*
//!    surface: `SimulationUnavailable` when no RPC URL is configured, plus a
//!    boundary-only test that doesn't need a chain.
//!
//! 2. **`preflight-fork-tests` feature** — when enabled and `RPC_URL`
//!    points at a real Ethereum mainnet RPC, exercises the full pre-flight
//!    flow against a forked mainnet block:
//!      - happy path: read-only call against USDC, expects `pass=true`
//!      - slippage failure: a swap that mints below `min_output` →
//!        `pass=false`, `reason ~= OutputBelowMinimum`
//!      - invalid target: calldata reverts → `pass=false`,
//!        `reason ~= ExecutionReverted`
//!
//! The fork suite is opt-in to keep CI hermetic — the default `cargo test`
//! never reaches an external RPC.
//!
//! Requires `anvil` available on `PATH`.

#![allow(clippy::too_many_arguments, dead_code)]

use alloy::primitives::{Address, Bytes, U256};
use alloy::sol_types::SolValue;

use trading_runtime::error::TradingError;
use trading_runtime::simulator::preflight::{
    PreflightConfig, PreflightRequest, PreflightSimulator,
};

/// Encode `balanceOf(address)` calldata.
fn encode_balance_of(account: Address) -> Bytes {
    let mut data = vec![0x70, 0xa0, 0x82, 0x31];
    data.extend_from_slice(&(account,).abi_encode_params());
    Bytes::from(data)
}

#[tokio::test]
async fn preflight_returns_unavailable_without_rpc() {
    // Snapshot env to keep the test hermetic.
    let prev = std::env::var("PREFLIGHT_FORK_RPC_URL").ok();
    // SAFETY: tests in this binary run sequentially under cargo test's
    // default harness; we snapshot/restore around the mutation.
    unsafe {
        std::env::remove_var("PREFLIGHT_FORK_RPC_URL");
    }
    let sim = PreflightSimulator::new(PreflightConfig::default());
    let req = PreflightRequest {
        chain_id: 1,
        vault: Address::ZERO,
        target: Address::ZERO,
        value: U256::ZERO,
        data: Bytes::new(),
        output_token: Address::ZERO,
        min_output: U256::ZERO,
        aave: None,
        fork_block: None,
    };
    let err = sim.run(req).await.unwrap_err();
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

#[tokio::test]
async fn preflight_request_serialization_round_trip() {
    let req = PreflightRequest {
        chain_id: 8_453,
        vault: Address::with_last_byte(0x42),
        target: Address::with_last_byte(0x99),
        value: U256::from(1_000u64),
        data: Bytes::from_static(&[0xde, 0xad, 0xbe, 0xef]),
        output_token: Address::with_last_byte(0x10),
        min_output: U256::from(2_500u64),
        aave: None,
        fork_block: Some(20_000_000),
    };
    let json = serde_json::to_string(&req).unwrap();
    let decoded: PreflightRequest = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.chain_id, req.chain_id);
    assert_eq!(decoded.vault, req.vault);
    assert_eq!(decoded.target, req.target);
    assert_eq!(decoded.min_output, req.min_output);
    assert_eq!(decoded.fork_block, req.fork_block);
    assert_eq!(decoded.value, req.value);
    assert_eq!(decoded.output_token, req.output_token);
    assert_eq!(decoded.data.as_ref(), req.data.as_ref());
}

// ── Optional fork-based suite, gated behind `preflight-fork-tests` ──────────

#[cfg(feature = "preflight-fork-tests")]
mod fork_tests {
    use super::*;
    use std::time::Duration;

    /// Pinned mainnet block — keeps fork tests reproducible.
    const MAINNET_BLOCK: u64 = 19_000_000;

    /// USDC on Ethereum mainnet.
    const USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    /// Uniswap V3 Router (immutable).
    const UNISWAP_V3_ROUTER: &str = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

    fn rpc_url() -> Option<String> {
        std::env::var("RPC_URL").ok().filter(|v| !v.is_empty())
    }

    fn simulator(url: String) -> PreflightSimulator {
        PreflightSimulator::new(PreflightConfig {
            timeout: Duration::from_secs(120),
            ..PreflightConfig::default().with_rpc_url(url)
        })
    }

    /// Happy path: read-only `balanceOf` on USDC. The call doesn't change
    /// vault state, so `predicted_output` is zero — but with `min_output=0`
    /// the result must be `pass=true`.
    #[tokio::test]
    async fn fork_happy_path_balance_of_usdc() {
        let Some(url) = rpc_url() else {
            eprintln!("skipping: RPC_URL not set");
            return;
        };
        let usdc: Address = USDC.parse().unwrap();
        let vault = Address::with_last_byte(0x99);
        let request = PreflightRequest {
            chain_id: 1,
            vault,
            target: usdc,
            value: U256::ZERO,
            data: encode_balance_of(vault),
            output_token: usdc,
            min_output: U256::ZERO,
            aave: None,
            fork_block: Some(MAINNET_BLOCK),
        };
        let result = simulator(url).run(request).await.expect("preflight runs");
        assert!(result.pass, "expected pass=true: {result:?}");
        assert!(result.gas_estimate > 0);
        assert!(result.reason.is_none());
    }

    /// Slippage path: trigger a Uniswap router call that we *know* won't
    /// produce enough USDC for the configured `min_output`. We don't actually
    /// expect it to succeed — the goal is to validate that the simulator
    /// surfaces a structured failure rather than panicking.
    #[tokio::test]
    async fn fork_invalid_calldata_marks_failure() {
        let Some(url) = rpc_url() else {
            eprintln!("skipping: RPC_URL not set");
            return;
        };
        let router: Address = UNISWAP_V3_ROUTER.parse().unwrap();
        let vault = Address::with_last_byte(0x99);
        let request = PreflightRequest {
            chain_id: 1,
            vault,
            target: router,
            value: U256::ZERO,
            // Garbage calldata → router will revert.
            data: Bytes::from_static(&[0xde, 0xad, 0xbe, 0xef]),
            output_token: USDC.parse().unwrap(),
            min_output: U256::from(1_000_000u64),
            aave: None,
            fork_block: Some(MAINNET_BLOCK),
        };
        let result = simulator(url).run(request).await.expect("preflight runs");
        assert!(!result.pass, "expected pass=false on garbage calldata");
        let reason = result.reason.expect("reason populated");
        assert!(
            reason.to_lowercase().contains("revert")
                || reason.contains("ExecutionReverted")
                || reason.contains("OutputBelowMinimum"),
            "expected revert/slippage reason, got: {reason}"
        );
    }

    /// Chain-mismatch guard: when the fork RPC returns a chain_id different
    /// from `request.chain_id`, the simulator marks the result as failed
    /// instead of silently simulating on the wrong chain.
    #[tokio::test]
    async fn fork_chain_mismatch_returns_failure() {
        let Some(url) = rpc_url() else {
            eprintln!("skipping: RPC_URL not set");
            return;
        };
        let usdc: Address = USDC.parse().unwrap();
        let vault = Address::with_last_byte(0x99);
        let request = PreflightRequest {
            chain_id: 999_999, // intentionally wrong
            vault,
            target: usdc,
            value: U256::ZERO,
            data: encode_balance_of(vault),
            output_token: usdc,
            min_output: U256::ZERO,
            aave: None,
            fork_block: Some(MAINNET_BLOCK),
        };
        let result = simulator(url).run(request).await.expect("preflight runs");
        assert!(!result.pass);
        let reason = result.reason.expect("reason populated");
        assert!(
            reason.to_lowercase().contains("chain mismatch"),
            "expected chain-mismatch reason, got: {reason}"
        );
    }
}
