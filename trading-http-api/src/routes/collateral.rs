use crate::TradingApiState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::{
    Json, Router,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use trading_runtime::vault_client::VaultClient;

// ── Request / Response types ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ReleaseCollateralRequest {
    pub amount: String,
    pub recipient: String,
    pub intent_hash: String,
    pub deadline: u64,
    pub validation: ReleaseValidation,
}

#[derive(Deserialize)]
pub struct ReleaseValidation {
    pub responses: Vec<ValidatorSig>,
}

#[derive(Deserialize)]
pub struct ValidatorSig {
    pub signature: String,
    pub score: u64,
}

#[derive(Serialize)]
pub struct ReleaseCollateralResponse {
    pub tx_hash: String,
    pub amount: String,
    pub recipient: String,
}

#[derive(Deserialize)]
pub struct ReturnCollateralRequest {
    pub amount: String,
}

#[derive(Serialize)]
pub struct ReturnCollateralResponse {
    pub tx_hash: String,
    pub amount: String,
}

#[derive(Serialize)]
pub struct CollateralStatusResponse {
    pub total_outstanding: String,
    pub operator_outstanding: String,
    pub max_collateral_bps: String,
    pub available: String,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn release_collateral(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<ReleaseCollateralRequest>,
) -> Result<Json<ReleaseCollateralResponse>, (StatusCode, String)> {
    let vault_client = VaultClient::new(
        state.vault_address.clone(),
        state.rpc_url.clone().unwrap_or_default(),
        state.chain_id.unwrap_or(1),
    );

    // Parse intent hash
    let intent_hash_bytes: [u8; 32] = hex::decode(req.intent_hash.trim_start_matches("0x"))
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid intent_hash: {e}")))?
        .try_into()
        .map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "intent_hash must be 32 bytes".to_string(),
            )
        })?;

    // Parse signatures and scores
    let mut signatures = Vec::new();
    let mut scores = Vec::new();
    for resp in &req.validation.responses {
        let sig_bytes = hex::decode(resp.signature.trim_start_matches("0x"))
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid signature: {e}")))?;
        signatures.push(sig_bytes);
        scores.push(alloy::primitives::U256::from(resp.score));
    }

    let deadline = alloy::primitives::U256::from(req.deadline);

    let encoded = vault_client
        .encode_release_collateral(
            &req.amount,
            &req.recipient,
            intent_hash_bytes,
            deadline,
            signatures,
            scores,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    // Submit via ChainClient if available, otherwise return encoded data
    let tx_hash = submit_tx(&state, &encoded).await?;

    Ok(Json(ReleaseCollateralResponse {
        tx_hash,
        amount: req.amount,
        recipient: req.recipient,
    }))
}

async fn return_collateral(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<ReturnCollateralRequest>,
) -> Result<Json<ReturnCollateralResponse>, (StatusCode, String)> {
    use alloy::primitives::{Address, Bytes, U256};
    use alloy::providers::Provider;
    use alloy::rpc::types::TransactionRequest;
    use alloy::sol_types::{SolCall, SolValue};
    use trading_runtime::contracts::{IERC20, ITradingVault};

    let vault_addr: Address = state.vault_address.parse().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Invalid vault address: {e}"),
        )
    })?;

    let amount = U256::from_str_radix(&req.amount, 10)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid amount: {e}")))?;

    let chain_client = state.executor.chain_client();

    // Step 1: Query the vault's deposit asset address
    let asset_call = ITradingVault::assetCall {};
    let asset_tx = TransactionRequest::default()
        .to(vault_addr)
        .input(Bytes::from(asset_call.abi_encode()).into());
    let asset_result = chain_client.provider().call(asset_tx).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to query vault asset: {e}"),
        )
    })?;
    let asset_addr = Address::abi_decode(&asset_result).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode asset address: {e}"),
        )
    })?;

    // Step 2: Approve the vault to pull the deposit asset
    let approve_call = IERC20::approveCall {
        spender: vault_addr,
        value: amount,
    };
    let approve_tx = TransactionRequest::default()
        .to(asset_addr)
        .input(Bytes::from(approve_call.abi_encode()).into());
    let approve_pending = chain_client
        .provider()
        .send_transaction(approve_tx)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Approve tx failed: {e}")))?;
    approve_pending.get_receipt().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Approve receipt failed: {e}"),
        )
    })?;

    // Step 3: Call returnCollateral (which does safeTransferFrom)
    let vault_client = VaultClient::new(
        state.vault_address.clone(),
        state.rpc_url.clone().unwrap_or_default(),
        state.chain_id.unwrap_or(1),
    );
    let encoded = vault_client
        .encode_return_collateral(&req.amount)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let tx_hash = submit_tx(&state, &encoded).await?;

    Ok(Json(ReturnCollateralResponse {
        tx_hash,
        amount: req.amount,
    }))
}

async fn collateral_status(
    State(state): State<Arc<TradingApiState>>,
) -> Result<Json<CollateralStatusResponse>, (StatusCode, String)> {
    use alloy::primitives::Address;
    use alloy::sol_types::SolCall;
    use trading_runtime::contracts::ITradingVault;

    let rpc_url = state.rpc_url.as_deref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "No RPC URL configured".to_string(),
    ))?;

    let vault_addr: Address = state.vault_address.parse().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Invalid vault address: {e}"),
        )
    })?;

    let provider =
        alloy::providers::ProviderBuilder::new().connect_http(rpc_url.parse().map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Invalid RPC URL: {e}"),
            )
        })?);

    let operator_addr: Address = state.operator_address.parse().unwrap_or(Address::ZERO);

    // Read view functions via eth_call
    let total_outstanding = eth_call_u256(
        &provider,
        vault_addr,
        ITradingVault::totalOutstandingCollateralCall {}.abi_encode(),
    )
    .await
    .unwrap_or_default();

    let operator_outstanding = eth_call_u256(
        &provider,
        vault_addr,
        ITradingVault::operatorCollateralCall {
            operator: operator_addr,
        }
        .abi_encode(),
    )
    .await
    .unwrap_or_default();

    let max_bps = eth_call_u256(
        &provider,
        vault_addr,
        ITradingVault::maxCollateralBpsCall {}.abi_encode(),
    )
    .await
    .unwrap_or_default();

    let available = eth_call_u256(
        &provider,
        vault_addr,
        ITradingVault::availableCollateralCall {}.abi_encode(),
    )
    .await
    .unwrap_or_default();

    Ok(Json(CollateralStatusResponse {
        total_outstanding: total_outstanding.to_string(),
        operator_outstanding: operator_outstanding.to_string(),
        max_collateral_bps: max_bps.to_string(),
        available: available.to_string(),
    }))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Submit a transaction via the executor's ChainClient.
async fn submit_tx(
    state: &TradingApiState,
    encoded: &trading_runtime::vault_client::EncodedTransaction,
) -> Result<String, (StatusCode, String)> {
    use alloy::primitives::{Address, Bytes, U256};
    use alloy::providers::Provider;
    use alloy::rpc::types::TransactionRequest;

    let chain_client = state.executor.chain_client();

    let to_addr: Address = encoded.to.parse().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Invalid to address: {e}"),
        )
    })?;

    let tx = TransactionRequest::default()
        .to(to_addr)
        .input(Bytes::from(encoded.data.clone()).into())
        .value(
            U256::from_str_radix(encoded.value.trim_start_matches("0x"), 10).unwrap_or(U256::ZERO),
        );

    let pending = chain_client
        .provider()
        .send_transaction(tx)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Transaction send failed: {e}"),
            )
        })?;

    let receipt = pending.get_receipt().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Receipt fetch failed: {e}"),
        )
    })?;

    Ok(format!("{:#x}", receipt.transaction_hash))
}

/// Read a uint256 via eth_call (view function).
async fn eth_call_u256(
    provider: &impl alloy::providers::Provider,
    to: alloy::primitives::Address,
    data: Vec<u8>,
) -> Result<alloy::primitives::U256, String> {
    use alloy::primitives::Bytes;
    use alloy::rpc::types::TransactionRequest;
    use alloy::sol_types::SolValue;

    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());

    let result = provider
        .call(tx)
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;

    alloy::primitives::U256::abi_decode(&result).map_err(|e| format!("ABI decode failed: {e}"))
}

// ── Router ───────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/collateral/release", post(release_collateral))
        .route("/collateral/return", post(return_collateral))
        .route("/collateral/status", get(collateral_status))
}
