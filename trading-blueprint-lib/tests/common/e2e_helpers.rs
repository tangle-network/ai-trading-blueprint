//! Shared helpers for E2E integration tests.
//!
//! Reusable functions for the validate → execute → verify cycle that
//! both the harness and binary E2E tests use.
//!
//! Includes on-chain vault execution, fee settlement, and balance helpers.

use alloy::primitives::{Address, Bytes, FixedBytes, U256};
use alloy::providers::Provider;
use anyhow::{Context, Result};
use serde_json::Value;
use std::time::Duration;

use super::contract_deployer;
use super::contract_deployer::FullTradeStack;

/// Well-known mainnet token addresses — AI evaluates these realistically.
pub const WETH: &str = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
pub const USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// ── HTTP API helpers ────────────────────────────────────────────────────────

/// Validate a trade via the Trading HTTP API.
///
/// Sends a WETH→USDC swap request and returns the JSON response body.
pub async fn validate_trade(
    client: &reqwest::Client,
    api_url: &str,
    api_token: &str,
) -> Result<Value> {
    let resp = client
        .post(format!("{api_url}/validate"))
        .header("Authorization", format!("Bearer {api_token}"))
        .json(&serde_json::json!({
            "strategy_id": "e2e-full-pipeline",
            "action": "swap",
            "token_in": WETH,
            "token_out": USDC,
            "amount_in": "1000",
            "min_amount_out": "950",
            "target_protocol": "uniswap_v3",
            "deadline_secs": 3600
        }))
        .send()
        .await
        .context("POST /validate request failed")?;

    let status = resp.status();
    let body: Value = resp.json().await.context("parse validate response")?;

    if !status.is_success() {
        anyhow::bail!("POST /validate returned {status}: {body}");
    }

    Ok(body)
}

/// Execute a trade via the Trading HTTP API using a previous validation result.
///
/// Builds the `ExecuteRequest` from the validate response body.
pub async fn execute_trade(
    client: &reqwest::Client,
    api_url: &str,
    api_token: &str,
    validate_response: &Value,
) -> Result<Value> {
    let execute_body = serde_json::json!({
        "intent": {
            "strategy_id": "e2e-full-pipeline",
            "action": "swap",
            "token_in": WETH,
            "token_out": USDC,
            "amount_in": "1000",
            "min_amount_out": "950",
            "target_protocol": "uniswap_v3"
        },
        "validation": {
            "approved": validate_response["approved"],
            "aggregate_score": validate_response["aggregate_score"],
            "intent_hash": validate_response["intent_hash"],
            "validator_responses": validate_response["validator_responses"]
        }
    });

    let resp = client
        .post(format!("{api_url}/execute"))
        .header("Authorization", format!("Bearer {api_token}"))
        .json(&execute_body)
        .send()
        .await
        .context("POST /execute request failed")?;

    let status = resp.status();
    let body: Value = resp.json().await.context("parse execute response")?;

    if !status.is_success() {
        anyhow::bail!("POST /execute returned {status}: {body}");
    }

    Ok(body)
}

/// Verify on-chain signatures using the TradeValidator contract.
///
/// Takes the first `n` validator signatures from the response and verifies
/// them against the on-chain contract. Returns `(approved, valid_count)`.
pub async fn verify_on_chain_signatures(
    provider: &impl Provider,
    tv_addr: Address,
    vault_addr: Address,
    validate_response: &Value,
    num_sigs: usize,
) -> Result<(bool, u64)> {
    let intent_hash = validate_response["intent_hash"]
        .as_str()
        .context("missing intent_hash")?;
    let ih_stripped = intent_hash.strip_prefix("0x").unwrap_or(intent_hash);
    let ih_bytes = hex::decode(ih_stripped)?;
    let mut ih_arr = [0u8; 32];
    ih_arr.copy_from_slice(&ih_bytes);

    let validator_responses = validate_response["validator_responses"]
        .as_array()
        .context("missing validator_responses")?;

    let mut sigs = Vec::new();
    let mut scores = Vec::new();
    for vr in validator_responses.iter().take(num_sigs) {
        let sig_str = vr["signature"].as_str().unwrap_or("");
        let sig_hex = sig_str.strip_prefix("0x").unwrap_or(sig_str);
        sigs.push(alloy::primitives::Bytes::from(hex::decode(sig_hex)?));
        scores.push(U256::from(vr["score"].as_u64().unwrap_or(0)));
    }

    let signed_deadline = validate_response["deadline"]
        .as_u64()
        .context("missing deadline in response")?;

    let tv = contract_deployer::TradeValidator::new(tv_addr, provider);
    let result = tv
        .validateWithSignatures(
            FixedBytes::<32>::from(ih_arr),
            vault_addr,
            sigs,
            scores,
            U256::from(signed_deadline),
        )
        .call()
        .await
        .context("validateWithSignatures call failed")?;

    Ok((result.approved, result.validCount.to::<u64>()))
}

/// Build a `reqwest::Client` with a generous timeout for E2E testing.
pub fn e2e_http_client(timeout_secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .expect("build reqwest client")
}

// ── On-chain token helpers ──────────────────────────────────────────────────

/// Mint mock ERC20 tokens to an address.
pub async fn mint_tokens(
    provider: &impl Provider,
    token_addr: Address,
    to: Address,
    amount: U256,
) -> Result<()> {
    let token = contract_deployer::MockERC20::new(token_addr, provider);
    token
        .mint(to, amount)
        .send()
        .await
        .context("mint send")?
        .get_receipt()
        .await
        .context("mint receipt")?;
    Ok(())
}

/// Approve a spender for ERC20 tokens.
pub async fn approve_tokens(
    provider: &impl Provider,
    token_addr: Address,
    spender: Address,
    amount: U256,
) -> Result<()> {
    let token = contract_deployer::MockERC20::new(token_addr, provider);
    token
        .approve(spender, amount)
        .send()
        .await
        .context("approve send")?
        .get_receipt()
        .await
        .context("approve receipt")?;
    Ok(())
}

/// Query ERC20 balance of an address.
pub async fn token_balance(
    provider: &impl Provider,
    token_addr: Address,
    account: Address,
) -> Result<U256> {
    let token = contract_deployer::MockERC20::new(token_addr, provider);
    let balance = token.balanceOf(account).call().await.context("balanceOf")?;
    Ok(balance)
}

// ── Vault interaction helpers ───────────────────────────────────────────────

/// Deposit tokens into the vault. Caller must have approved the vault first.
pub async fn deposit_to_vault(
    user_provider: &impl Provider,
    vault_addr: Address,
    amount: U256,
    receiver: Address,
) -> Result<()> {
    let vault = contract_deployer::TradingVault::new(vault_addr, user_provider);
    vault
        .deposit(amount, receiver)
        .send()
        .await
        .context("deposit send")?
        .get_receipt()
        .await
        .context("deposit receipt")?;
    Ok(())
}

/// Query the total assets in the vault.
pub async fn vault_total_assets(provider: &impl Provider, vault_addr: Address) -> Result<U256> {
    let vault = contract_deployer::TradingVault::new(vault_addr, provider);
    let total = vault.totalAssets().call().await.context("totalAssets")?;
    Ok(total)
}

/// Query a token balance held by the vault.
pub async fn vault_balance(
    provider: &impl Provider,
    vault_addr: Address,
    token_addr: Address,
) -> Result<U256> {
    let vault = contract_deployer::TradingVault::new(vault_addr, provider);
    let balance = vault
        .getBalance(token_addr)
        .call()
        .await
        .context("getBalance")?;
    Ok(balance)
}

// ── On-chain vault execution ────────────────────────────────────────────────

/// Execute a trade directly on-chain via vault.execute() using MockTarget.
///
/// Takes validator signatures from a `/validate` response and constructs
/// the on-chain vault.execute() call with MockTarget.swap as the target.
///
/// Returns the transaction hash.
pub async fn execute_vault_trade_on_chain(
    operator_provider: &impl Provider,
    stack: &FullTradeStack,
    validate_response: &Value,
    output_amount: U256,
    min_output: U256,
) -> Result<String> {
    // Extract intent_hash, signatures, scores, deadline from validate response
    let intent_hash_str = validate_response["intent_hash"]
        .as_str()
        .context("missing intent_hash")?;
    let ih_stripped = intent_hash_str
        .strip_prefix("0x")
        .unwrap_or(intent_hash_str);
    let ih_bytes = hex::decode(ih_stripped)?;
    let mut ih_arr = [0u8; 32];
    ih_arr.copy_from_slice(&ih_bytes);

    let deadline = validate_response["deadline"]
        .as_u64()
        .context("missing deadline")?;

    let validator_responses = validate_response["validator_responses"]
        .as_array()
        .context("missing validator_responses")?;

    let mut sigs = Vec::new();
    let mut scores = Vec::new();
    for vr in validator_responses {
        let sig_str = vr["signature"].as_str().unwrap_or("");
        let sig_hex = sig_str.strip_prefix("0x").unwrap_or(sig_str);
        sigs.push(Bytes::from(hex::decode(sig_hex)?));
        scores.push(U256::from(vr["score"].as_u64().unwrap_or(0)));
    }

    // Encode MockTarget.swap(vault, outputAmount) as calldata
    let swap_calldata = contract_deployer::encode_mock_swap(stack.vault, output_amount);

    let params = contract_deployer::TradingVault::ExecuteParams {
        target: stack.mock_target,
        data: Bytes::from(swap_calldata),
        value: U256::ZERO,
        minOutput: min_output,
        outputToken: stack.token_b,
        intentHash: FixedBytes::from(ih_arr),
        deadline: U256::from(deadline),
    };

    let vault = contract_deployer::TradingVault::new(stack.vault, operator_provider);
    let pending = vault
        .execute(params, sigs, scores)
        .send()
        .await
        .context("vault.execute send")?;

    let tx_hash = format!("0x{}", hex::encode(pending.tx_hash().as_slice()));

    let receipt = pending
        .get_receipt()
        .await
        .context("vault.execute receipt")?;
    assert!(
        receipt.status(),
        "vault.execute() transaction should succeed"
    );

    Ok(tx_hash)
}

// ── Fee settlement helpers ──────────────────────────────────────────────────

/// Settle fees via FeeDistributor. Returns `(accumulated_fees, high_water_mark)`.
///
/// Must be called from the FeeDistributor owner (deployer).
pub async fn settle_fees_on_chain(
    provider: &impl Provider,
    fd_addr: Address,
    vault_addr: Address,
    fee_token: Address,
) -> Result<(U256, U256)> {
    let fd = contract_deployer::FeeDistributor::new(fd_addr, provider);
    let pending = fd
        .settleFees(vault_addr, fee_token)
        .send()
        .await
        .context("settleFees send")?;

    let receipt = pending.get_receipt().await.context("settleFees receipt")?;
    assert!(receipt.status(), "settleFees transaction should succeed");

    let accumulated = fd
        .accumulatedFees(fee_token)
        .call()
        .await
        .context("accumulatedFees")?;
    let hwm = fd
        .highWaterMark(vault_addr)
        .call()
        .await
        .context("highWaterMark")?;

    Ok((accumulated, hwm))
}

/// Settle fees and return the per-call breakdown: `(perf_fee, mgmt_fee, hwm, last_settled)`.
///
/// Uses `eth_call` to simulate `settleFees` (read return values) then sends
/// the actual transaction. This is needed because `send()` doesn't return
/// the function's return values — only the transaction receipt.
pub async fn settle_fees_with_breakdown(
    provider: &impl Provider,
    fd_addr: Address,
    vault_addr: Address,
    fee_token: Address,
) -> Result<(U256, U256, U256, U256)> {
    let fd = contract_deployer::FeeDistributor::new(fd_addr, provider);

    // Simulate the call to capture return values
    let sim = fd
        .settleFees(vault_addr, fee_token)
        .call()
        .await
        .context("settleFees simulate")?;
    let perf_fee = sim.perfFee;
    let mgmt_fee = sim.mgmtFee;

    // Now actually send the transaction
    let pending = fd
        .settleFees(vault_addr, fee_token)
        .send()
        .await
        .context("settleFees send")?;
    let receipt = pending.get_receipt().await.context("settleFees receipt")?;
    assert!(receipt.status(), "settleFees transaction should succeed");

    let hwm = fd
        .highWaterMark(vault_addr)
        .call()
        .await
        .context("highWaterMark")?;
    let last_settled = fd
        .lastSettled(vault_addr)
        .call()
        .await
        .context("lastSettled")?;

    Ok((perf_fee, mgmt_fee, hwm, last_settled))
}

/// Read on-chain fee parameters from FeeDistributor.
///
/// Returns `(performance_fee_bps, management_fee_bps, validator_share_bps)`.
pub async fn read_fee_params(
    provider: &impl Provider,
    fd_addr: Address,
) -> Result<(U256, U256, U256)> {
    let fd = contract_deployer::FeeDistributor::new(fd_addr, provider);
    let perf_bps = fd
        .performanceFeeBps()
        .call()
        .await
        .context("performanceFeeBps")?;
    let mgmt_bps = fd
        .managementFeeBps()
        .call()
        .await
        .context("managementFeeBps")?;
    let val_share_bps = fd
        .validatorFeeShareBps()
        .call()
        .await
        .context("validatorFeeShareBps")?;
    Ok((perf_bps, mgmt_bps, val_share_bps))
}

/// Read the current block timestamp from Anvil.
pub async fn get_block_timestamp(provider: &impl Provider) -> Result<u64> {
    let block_num = provider
        .get_block_number()
        .await
        .context("get_block_number")?;
    let block = provider
        .get_block_by_number(block_num.into())
        .await
        .context("get latest block")?
        .context("latest block not found")?;
    Ok(block.header.timestamp)
}

// ── Anvil time manipulation ─────────────────────────────────────────────────

/// Advance Anvil block timestamp by `seconds` and mine a new block.
pub async fn advance_anvil_time(provider: &impl Provider, seconds: u64) -> Result<()> {
    provider
        .raw_request::<_, serde_json::Value>("evm_increaseTime".into(), [seconds])
        .await
        .context("evm_increaseTime")?;
    provider
        .raw_request::<_, serde_json::Value>("evm_mine".into(), ())
        .await
        .context("evm_mine")?;
    Ok(())
}
