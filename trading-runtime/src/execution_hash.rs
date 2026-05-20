use alloy::primitives::{Address, B256, Bytes, U256, keccak256};
use alloy::sol_types::SolValue;

use crate::adapters::{Approval, EncodedAction};
use crate::hyperliquid::{AssetId, HlOrderType, PlaceOrderRequest};
use crate::polymarket_clob::{ClobOrderParams, Side};

const EXECUTION_PAYLOAD_TYPE: &str = "ExecutionPayload(address target,bytes32 dataHash,uint256 value,uint256 minOutput,address outputToken,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)";
const DEBT_REDUCTION_PAYLOAD_TYPE: &str = "DebtReductionPayload(address target,bytes32 dataHash,uint256 value,address inputToken,uint256 maxInput,address debtToken,uint256 minDebtDecrease,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)";
const HEALTH_FACTOR_PAYLOAD_TYPE: &str = "HealthFactorPayload(address target,bytes32 dataHash,uint256 value,uint256 minOutput,address outputToken,address pool,address account,uint256 minHealthFactor,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)";
const APPROVAL_CALL_TYPE: &str = "ApprovalCall(address token,address spender,uint256 amount)";
const COLLATERAL_RELEASE_TYPE: &str = "CollateralRelease(uint256 amount,address recipient,bytes32 intentHash,uint256 deadline,uint256 chainId)";
const CLOB_ORDER_TYPE: &str = "ClobOrder(bytes32 tokenIdHash,bytes32 sideHash,bytes32 priceHash,bytes32 sizeHash,bytes32 orderTypeHash,uint256 expiration,bytes32 intentHash,uint256 deadline,uint256 chainId)";
const HYPERLIQUID_ORDER_TYPE: &str = "HyperliquidOrder(bytes32 accountHash,bytes32 assetHash,bool isBuy,bytes32 sizeHash,bytes32 orderTypeHash,bool reduceOnly,bytes32 cloidHash,bytes32 intentHash,uint256 deadline,uint256 chainId)";

pub const ACTION_KIND_VAULT_EXECUTE: u64 = 0;
pub const ACTION_KIND_COLLATERAL_RELEASE: u64 = 1;
pub const ACTION_KIND_CLOB_ORDER: u64 = 2;
pub const ACTION_KIND_HYPERLIQUID_ORDER: u64 = 3;

pub fn execution_payload_typehash() -> B256 {
    keccak256(EXECUTION_PAYLOAD_TYPE.as_bytes())
}

pub fn debt_reduction_payload_typehash() -> B256 {
    keccak256(DEBT_REDUCTION_PAYLOAD_TYPE.as_bytes())
}

pub fn health_factor_payload_typehash() -> B256 {
    keccak256(HEALTH_FACTOR_PAYLOAD_TYPE.as_bytes())
}

pub fn approval_call_typehash() -> B256 {
    keccak256(APPROVAL_CALL_TYPE.as_bytes())
}

pub fn collateral_release_typehash() -> B256 {
    keccak256(COLLATERAL_RELEASE_TYPE.as_bytes())
}

pub fn clob_order_typehash() -> B256 {
    keccak256(CLOB_ORDER_TYPE.as_bytes())
}

pub fn hyperliquid_order_typehash() -> B256 {
    keccak256(HYPERLIQUID_ORDER_TYPE.as_bytes())
}

pub fn hash_approvals(approvals: &[Approval]) -> B256 {
    let mut packed = Vec::with_capacity(approvals.len() * 32);
    for approval in approvals {
        let hash = keccak256(SolValue::abi_encode(&(
            approval_call_typehash(),
            approval.token,
            approval.spender,
            approval.amount,
        )));
        packed.extend_from_slice(hash.as_slice());
    }
    keccak256(packed)
}

pub fn hash_execution_payload(
    encoded: &EncodedAction,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
) -> B256 {
    let approvals_hash = hash_approvals(&encoded.approvals);
    if let Some(debt_reduction) = &encoded.debt_reduction {
        return hash_debt_reduction_payload_parts(
            encoded.target,
            &encoded.calldata,
            encoded.value,
            debt_reduction.input_token,
            debt_reduction.max_input,
            debt_reduction.debt_token,
            debt_reduction.min_debt_decrease,
            intent_hash,
            deadline,
            chain_id,
            approvals_hash,
        );
    }
    if let Some(health_factor) = &encoded.health_factor {
        return hash_health_factor_payload_parts(
            encoded.target,
            &encoded.calldata,
            encoded.value,
            encoded.min_output,
            encoded.output_token,
            health_factor.pool,
            health_factor.account,
            health_factor.min_health_factor,
            intent_hash,
            deadline,
            chain_id,
            approvals_hash,
        );
    }

    hash_execution_payload_parts(
        encoded.target,
        &encoded.calldata,
        encoded.value,
        encoded.min_output,
        encoded.output_token,
        intent_hash,
        deadline,
        chain_id,
        approvals_hash,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn hash_health_factor_payload_parts(
    target: Address,
    calldata: &Bytes,
    value: U256,
    min_output: U256,
    output_token: Address,
    pool: Address,
    account: Address,
    min_health_factor: U256,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
    approvals_hash: B256,
) -> B256 {
    keccak256(SolValue::abi_encode(&(
        health_factor_payload_typehash(),
        target,
        keccak256(calldata),
        value,
        min_output,
        output_token,
        pool,
        account,
        min_health_factor,
        intent_hash,
        deadline,
        U256::from(chain_id),
        approvals_hash,
    )))
}

#[allow(clippy::too_many_arguments)]
pub fn hash_execution_payload_parts(
    target: Address,
    calldata: &Bytes,
    value: U256,
    min_output: U256,
    output_token: Address,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
    approvals_hash: B256,
) -> B256 {
    keccak256(SolValue::abi_encode(&(
        execution_payload_typehash(),
        target,
        keccak256(calldata),
        value,
        min_output,
        output_token,
        intent_hash,
        deadline,
        U256::from(chain_id),
        approvals_hash,
    )))
}

#[allow(clippy::too_many_arguments)]
pub fn hash_debt_reduction_payload_parts(
    target: Address,
    calldata: &Bytes,
    value: U256,
    input_token: Address,
    max_input: U256,
    debt_token: Address,
    min_debt_decrease: U256,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
    approvals_hash: B256,
) -> B256 {
    keccak256(SolValue::abi_encode(&(
        debt_reduction_payload_typehash(),
        target,
        keccak256(calldata),
        value,
        input_token,
        max_input,
        debt_token,
        min_debt_decrease,
        intent_hash,
        deadline,
        U256::from(chain_id),
        approvals_hash,
    )))
}

pub fn hash_collateral_release(
    amount: U256,
    recipient: Address,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
) -> B256 {
    keccak256(SolValue::abi_encode(&(
        collateral_release_typehash(),
        amount,
        recipient,
        intent_hash,
        deadline,
        U256::from(chain_id),
    )))
}

pub fn hash_clob_order(
    params: &ClobOrderParams,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
) -> B256 {
    let side = match params.side {
        Side::Buy => "BUY",
        Side::Sell => "SELL",
    };
    hash_clob_order_parts(
        &params.token_id,
        side,
        &params.price.normalize().to_string(),
        &params.size.normalize().to_string(),
        &params.order_type.to_string(),
        params.expiration,
        intent_hash,
        deadline,
        chain_id,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn hash_clob_order_parts(
    token_id: &str,
    side: &str,
    price: &str,
    size: &str,
    order_type: &str,
    expiration: u64,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
) -> B256 {
    keccak256(SolValue::abi_encode(&(
        clob_order_typehash(),
        keccak256(token_id.as_bytes()),
        keccak256(side.as_bytes()),
        keccak256(price.as_bytes()),
        keccak256(size.as_bytes()),
        keccak256(order_type.as_bytes()),
        U256::from(expiration),
        intent_hash,
        deadline,
        U256::from(chain_id),
    )))
}

pub fn hash_hyperliquid_order(
    request: &PlaceOrderRequest,
    account: &str,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
) -> B256 {
    hash_hyperliquid_order_parts(
        account,
        &hyperliquid_asset_key(&request.asset),
        request.is_buy,
        &request.size,
        &hyperliquid_order_type_key(&request.order_type),
        request.reduce_only,
        request.cloid.as_deref().unwrap_or(""),
        intent_hash,
        deadline,
        chain_id,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn hash_hyperliquid_order_parts(
    account: &str,
    asset: &str,
    is_buy: bool,
    size: &str,
    order_type: &str,
    reduce_only: bool,
    cloid: &str,
    intent_hash: B256,
    deadline: U256,
    chain_id: u64,
) -> B256 {
    keccak256(SolValue::abi_encode(&(
        hyperliquid_order_typehash(),
        keccak256(account.trim().to_ascii_lowercase().as_bytes()),
        keccak256(asset.as_bytes()),
        is_buy,
        keccak256(size.as_bytes()),
        keccak256(order_type.as_bytes()),
        reduce_only,
        keccak256(cloid.as_bytes()),
        intent_hash,
        deadline,
        U256::from(chain_id),
    )))
}

fn hyperliquid_asset_key(asset: &AssetId) -> String {
    match asset {
        AssetId::Index(index) => format!("index:{index}"),
        AssetId::Symbol(symbol) => format!("symbol:{symbol}"),
    }
}

fn hyperliquid_order_type_key(order_type: &HlOrderType) -> String {
    match order_type {
        HlOrderType::Limit { price } => format!("limit:{price}"),
        HlOrderType::Market => "market".to_string(),
        HlOrderType::StopLoss {
            trigger_price,
            is_market,
        } => format!("stop_loss:{trigger_price}:{is_market}"),
        HlOrderType::TakeProfit {
            trigger_price,
            is_market,
        } => format!("take_profit:{trigger_price}:{is_market}"),
    }
}

pub fn format_b256(hash: B256) -> String {
    format!("0x{}", hex::encode(hash.as_slice()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_hash_is_order_sensitive() {
        let a = Approval {
            token: Address::from([1u8; 20]),
            spender: Address::from([2u8; 20]),
            amount: U256::from(10),
        };
        let b = Approval {
            token: Address::from([3u8; 20]),
            spender: Address::from([4u8; 20]),
            amount: U256::from(20),
        };

        assert_ne!(
            hash_approvals(&[a.clone(), b.clone()]),
            hash_approvals(&[b, a])
        );
    }

    #[test]
    fn execution_hash_changes_when_calldata_changes() {
        let base = EncodedAction {
            target: Address::from([1u8; 20]),
            calldata: Bytes::from(vec![1, 2, 3]),
            value: U256::ZERO,
            min_output: U256::from(10),
            output_token: Address::from([2u8; 20]),
            approvals: vec![],
            debt_reduction: None,
            health_factor: None,
        };
        let mut changed = base.clone();
        changed.calldata = Bytes::from(vec![1, 2, 4]);

        assert_ne!(
            hash_execution_payload(&base, B256::ZERO, U256::from(100), 31337),
            hash_execution_payload(&changed, B256::ZERO, U256::from(100), 31337)
        );
    }

    #[test]
    fn execution_hash_changes_for_debt_reduction_postcondition() {
        let mut base = EncodedAction {
            target: Address::from([1u8; 20]),
            calldata: Bytes::from(vec![1, 2, 3]),
            value: U256::ZERO,
            min_output: U256::ZERO,
            output_token: Address::from([2u8; 20]),
            approvals: vec![],
            debt_reduction: Some(crate::adapters::DebtReductionPostcondition {
                input_token: Address::from([3u8; 20]),
                max_input: U256::from(10),
                debt_token: Address::from([4u8; 20]),
                min_debt_decrease: U256::from(9),
            }),
            health_factor: None,
        };
        let original = hash_execution_payload(&base, B256::ZERO, U256::from(100), 31337);

        base.debt_reduction.as_mut().unwrap().min_debt_decrease = U256::from(8);

        assert_ne!(
            original,
            hash_execution_payload(&base, B256::ZERO, U256::from(100), 31337)
        );
    }

    #[test]
    fn execution_hash_changes_for_health_factor_postcondition() {
        let mut base = EncodedAction {
            target: Address::from([1u8; 20]),
            calldata: Bytes::from(vec![1, 2, 3]),
            value: U256::ZERO,
            min_output: U256::from(10),
            output_token: Address::from([2u8; 20]),
            approvals: vec![],
            debt_reduction: None,
            health_factor: Some(crate::adapters::HealthFactorPostcondition {
                pool: Address::from([3u8; 20]),
                account: Address::from([4u8; 20]),
                min_health_factor: U256::from(1_500_000_000_000_000_000u128),
            }),
        };
        let original = hash_execution_payload(&base, B256::ZERO, U256::from(100), 31337);

        base.health_factor.as_mut().unwrap().min_health_factor =
            U256::from(1_400_000_000_000_000_000u128);

        assert_ne!(
            original,
            hash_execution_payload(&base, B256::ZERO, U256::from(100), 31337)
        );
    }

    #[test]
    fn direct_order_hashes_change_when_order_changes() {
        let clob = ClobOrderParams {
            token_id: "123".to_string(),
            side: Side::Buy,
            price: rust_decimal::Decimal::new(65, 2),
            size: rust_decimal::Decimal::new(10, 0),
            order_type: crate::polymarket_clob::OrderType::Gtc,
            expiration: 0,
        };
        let mut changed_clob = clob.clone();
        changed_clob.price = rust_decimal::Decimal::new(66, 2);

        assert_ne!(
            hash_clob_order(&clob, B256::ZERO, U256::from(100), 137),
            hash_clob_order(&changed_clob, B256::ZERO, U256::from(100), 137)
        );

        let hl = PlaceOrderRequest {
            asset: AssetId::Symbol("ETH".to_string()),
            is_buy: true,
            size: "1.0".to_string(),
            order_type: HlOrderType::Market,
            reduce_only: false,
            cloid: None,
        };
        let mut changed_hl = hl.clone();
        changed_hl.reduce_only = true;

        assert_ne!(
            hash_hyperliquid_order(
                &hl,
                "0x1111111111111111111111111111111111111111",
                B256::ZERO,
                U256::from(100),
                42161
            ),
            hash_hyperliquid_order(
                &changed_hl,
                "0x1111111111111111111111111111111111111111",
                B256::ZERO,
                U256::from(100),
                42161
            )
        );

        assert_ne!(
            hash_hyperliquid_order(
                &hl,
                "0x1111111111111111111111111111111111111111",
                B256::ZERO,
                U256::from(100),
                42161
            ),
            hash_hyperliquid_order(
                &hl,
                "0x2222222222222222222222222222222222222222",
                B256::ZERO,
                U256::from(100),
                42161
            )
        );
    }
}
