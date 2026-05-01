use alloy::primitives::{Address, B256, Bytes, U256, keccak256};
use alloy::sol_types::SolValue;

use crate::adapters::{Approval, EncodedAction};

const EXECUTION_PAYLOAD_TYPE: &str = "ExecutionPayload(address target,bytes32 dataHash,uint256 value,uint256 minOutput,address outputToken,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)";
const APPROVAL_CALL_TYPE: &str = "ApprovalCall(address token,address spender,uint256 amount)";
const COLLATERAL_RELEASE_TYPE: &str = "CollateralRelease(uint256 amount,address recipient,bytes32 intentHash,uint256 deadline,uint256 chainId)";

pub fn execution_payload_typehash() -> B256 {
    keccak256(EXECUTION_PAYLOAD_TYPE.as_bytes())
}

pub fn approval_call_typehash() -> B256 {
    keccak256(APPROVAL_CALL_TYPE.as_bytes())
}

pub fn collateral_release_typehash() -> B256 {
    keccak256(COLLATERAL_RELEASE_TYPE.as_bytes())
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
        };
        let mut changed = base.clone();
        changed.calldata = Bytes::from(vec![1, 2, 4]);

        assert_ne!(
            hash_execution_payload(&base, B256::ZERO, U256::from(100), 31337),
            hash_execution_payload(&changed, B256::ZERO, U256::from(100), 31337)
        );
    }
}
