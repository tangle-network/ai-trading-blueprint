//! On-chain contract integration helpers.
//!
//! Wraps `ChainClient` + `sol!` bindings from `trading-runtime` to provide
//! high-level functions for:
//! - Vault creation via `VaultFactory.createVault()`
//! - Strategy registration via `StrategyRegistry.registerStrategy()`
//! - Fee settlement via `FeeDistributor.settleFees()`

use alloy::primitives::{Address, Bytes, FixedBytes, U256};
use alloy::providers::Provider;
use alloy::sol_types::SolCall;
use trading_runtime::chain::ChainClient;
use trading_runtime::contracts::{IFeeDistributor, IStrategyRegistry, IVaultFactory};

/// Result of deploying a vault via VaultFactory.
#[derive(Debug, Clone)]
pub struct VaultDeployment {
    pub vault_address: Address,
    pub share_token: Address,
    pub tx_hash: String,
}

/// Deploy a new vault via `VaultFactory.createVault()`.
///
/// # Arguments
/// * `chain` — Configured chain client with signing key
/// * `factory_address` — Address of the deployed VaultFactory contract
/// * `service_id` — Tangle service ID
/// * `asset_token` — ERC-20 token address for vault deposits
/// * `admin` — Vault admin address (usually operator or service owner)
/// * `operator` — Trading agent address (gets OPERATOR_ROLE)
/// * `signers` — Validator signer addresses for trade approval
/// * `required_sigs` — m-of-n threshold
/// * `name` — Share token name (e.g., "AI Yield Shares")
/// * `symbol` — Share token symbol (e.g., "aiYLD")
/// * `salt` — CREATE2 salt for deterministic addresses
pub async fn deploy_vault(
    chain: &ChainClient,
    factory_address: Address,
    service_id: u64,
    asset_token: Address,
    admin: Address,
    operator: Address,
    signers: Vec<Address>,
    required_sigs: U256,
    name: String,
    symbol: String,
    salt: FixedBytes<32>,
) -> Result<VaultDeployment, String> {
    let call = IVaultFactory::createVaultCall {
        serviceId: service_id,
        assetToken: asset_token,
        admin,
        operator,
        signers,
        requiredSigs: required_sigs,
        name,
        symbol,
        salt,
    };

    let tx = alloy::rpc::types::TransactionRequest::default()
        .to(factory_address)
        .input(Bytes::from(call.abi_encode()).into());

    let pending = chain
        .provider
        .send_transaction(tx)
        .await
        .map_err(|e| format!("VaultFactory.createVault tx send failed: {e}"))?;

    let tx_hash = format!("0x{}", hex::encode(pending.tx_hash().as_slice()));

    let receipt = pending
        .get_receipt()
        .await
        .map_err(|e| format!("VaultFactory.createVault receipt failed: {e}"))?;

    // Parse return values from the transaction receipt logs
    // The VaultCreated event contains: (serviceId, vault, shareToken, assetToken, admin, operator)
    let (vault_address, share_token) = parse_vault_created_event(&receipt)
        .unwrap_or((Address::ZERO, Address::ZERO));

    tracing::info!(
        "Vault deployed: vault={vault_address}, share={share_token}, tx={tx_hash}"
    );

    Ok(VaultDeployment {
        vault_address,
        share_token,
        tx_hash,
    })
}

/// Parse VaultCreated event from transaction receipt.
///
/// Event signature: VaultCreated(uint64 indexed serviceId, address indexed vault,
///                               address indexed shareToken, address assetToken,
///                               address admin, address operator)
fn parse_vault_created_event(
    receipt: &alloy::rpc::types::TransactionReceipt,
) -> Option<(Address, Address)> {
    // VaultCreated has 3 indexed topics: event sig, serviceId, vault, shareToken
    // topic[0] = keccak256("VaultCreated(uint64,address,address,address,address,address)")
    // topic[1] = serviceId
    // topic[2] = vault (indexed address)
    // topic[3] = shareToken (indexed address)
    for log in receipt.inner.logs() {
        let topics = log.topics();
        if topics.len() >= 4 {
            // Extract vault from topic[2] and shareToken from topic[3]
            let vault = Address::from_word(topics[2]);
            let share = Address::from_word(topics[3]);
            return Some((vault, share));
        }
    }
    None
}

/// Register a strategy in the on-chain StrategyRegistry.
///
/// Returns the strategy ID on success.
pub async fn register_strategy(
    chain: &ChainClient,
    registry_address: Address,
    service_id: u64,
    name: String,
    strategy_type: String,
    ipfs_hash: String,
) -> Result<u64, String> {
    let call = IStrategyRegistry::registerStrategyCall {
        serviceId: service_id,
        name,
        strategyType: strategy_type,
        ipfsHash: ipfs_hash,
    };

    let tx = alloy::rpc::types::TransactionRequest::default()
        .to(registry_address)
        .input(Bytes::from(call.abi_encode()).into());

    let pending = chain
        .provider
        .send_transaction(tx)
        .await
        .map_err(|e| format!("StrategyRegistry.registerStrategy tx failed: {e}"))?;

    let tx_hash = format!("0x{}", hex::encode(pending.tx_hash().as_slice()));

    let receipt = pending
        .get_receipt()
        .await
        .map_err(|e| format!("StrategyRegistry.registerStrategy receipt failed: {e}"))?;

    // Parse StrategyRegistered event to get the strategy ID
    // Event: StrategyRegistered(uint256 indexed strategyId, uint64 indexed serviceId, address indexed owner, string name)
    let strategy_id = parse_strategy_registered_event(&receipt).unwrap_or(0);

    tracing::info!("Strategy registered: id={strategy_id}, tx={tx_hash}");
    Ok(strategy_id)
}

/// Parse StrategyRegistered event from receipt.
fn parse_strategy_registered_event(
    receipt: &alloy::rpc::types::TransactionReceipt,
) -> Option<u64> {
    // topic[0] = event sig
    // topic[1] = strategyId (indexed uint256)
    for log in receipt.inner.logs() {
        let topics = log.topics();
        if topics.len() >= 2 {
            // strategyId is a uint256 in topic[1]
            let id = U256::from_be_bytes(topics[1].0);
            return Some(id.try_into().unwrap_or(0));
        }
    }
    None
}

/// Update strategy metrics on-chain.
pub async fn update_strategy_metrics(
    chain: &ChainClient,
    registry_address: Address,
    strategy_id: U256,
    aum: U256,
    pnl: i64,
) -> Result<(), String> {
    use alloy::primitives::I256;

    let call = IStrategyRegistry::updateMetricsCall {
        strategyId: strategy_id,
        aum,
        pnl: I256::try_from(pnl).unwrap_or(I256::ZERO),
    };

    let tx = alloy::rpc::types::TransactionRequest::default()
        .to(registry_address)
        .input(Bytes::from(call.abi_encode()).into());

    chain
        .provider
        .send_transaction(tx)
        .await
        .map_err(|e| format!("StrategyRegistry.updateMetrics tx failed: {e}"))?
        .get_receipt()
        .await
        .map_err(|e| format!("StrategyRegistry.updateMetrics receipt failed: {e}"))?;

    Ok(())
}

/// Settle fees for a vault via FeeDistributor.
///
/// Returns `(performance_fee, management_fee)` on success.
pub async fn settle_fees(
    chain: &ChainClient,
    fee_distributor_address: Address,
    vault_address: Address,
    fee_token: Address,
) -> Result<(U256, U256), String> {
    let call = IFeeDistributor::settleFeesCall {
        vault: vault_address,
        feeToken: fee_token,
    };

    let tx = alloy::rpc::types::TransactionRequest::default()
        .to(fee_distributor_address)
        .input(Bytes::from(call.abi_encode()).into());

    let pending = chain
        .provider
        .send_transaction(tx)
        .await
        .map_err(|e| format!("FeeDistributor.settleFees tx failed: {e}"))?;

    let tx_hash = format!("0x{}", hex::encode(pending.tx_hash().as_slice()));

    let receipt = pending
        .get_receipt()
        .await
        .map_err(|e| format!("FeeDistributor.settleFees receipt failed: {e}"))?;

    // Parse FeesSettled event
    // Event: FeesSettled(address indexed vault, address indexed feeToken,
    //                    uint256 performanceFee, uint256 managementFee,
    //                    uint256 validatorShare, uint256 protocolShare)
    let (perf, mgmt) = parse_fees_settled_event(&receipt).unwrap_or((U256::ZERO, U256::ZERO));

    tracing::info!(
        "Fees settled: vault={vault_address}, perf={perf}, mgmt={mgmt}, tx={tx_hash}"
    );

    Ok((perf, mgmt))
}

/// Parse FeesSettled event from receipt.
fn parse_fees_settled_event(
    receipt: &alloy::rpc::types::TransactionReceipt,
) -> Option<(U256, U256)> {
    // topic[0] = event sig, topic[1] = vault, topic[2] = feeToken
    // data = abi.encode(performanceFee, managementFee, validatorShare, protocolShare)
    for log in receipt.inner.logs() {
        let topics = log.topics();
        let data = log.data().data.as_ref();
        if topics.len() >= 3 && data.len() >= 64 {
            let perf = U256::from_be_slice(&data[0..32]);
            let mgmt = U256::from_be_slice(&data[32..64]);
            return Some((perf, mgmt));
        }
    }
    None
}
