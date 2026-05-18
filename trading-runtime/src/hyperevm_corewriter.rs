//! HyperEVM CoreWriter action encoding helpers.
//!
//! These helpers only build the bytes accepted by the Hyperliquid CoreWriter
//! system contract. Submitting the action must still be done by the account
//! that should own the HyperCore action, such as a bot-bound HyperEVM vault.

use alloy::primitives::{Address, Bytes};
use alloy::sol_types::SolValue;

pub const CORE_WRITER_ADDRESS: &str = "0x3333333333333333333333333333333333333333";
pub const CORE_WRITER_ENCODING_VERSION: u8 = 1;
pub const ACTION_ADD_API_WALLET: u32 = 9;

pub fn encode_corewriter_action(action_id: u32, payload: Vec<u8>) -> Result<Bytes, String> {
    if action_id > 0x00ff_ffff {
        return Err(format!("CoreWriter action id {action_id} exceeds 3 bytes"));
    }

    let mut data = Vec::with_capacity(4 + payload.len());
    data.push(CORE_WRITER_ENCODING_VERSION);
    data.push(((action_id >> 16) & 0xff) as u8);
    data.push(((action_id >> 8) & 0xff) as u8);
    data.push((action_id & 0xff) as u8);
    data.extend(payload);
    Ok(Bytes::from(data))
}

pub fn encode_add_api_wallet_action(
    agent_address: Address,
    agent_name: impl AsRef<str>,
) -> Result<Bytes, String> {
    let payload = SolValue::abi_encode(&(agent_address, agent_name.as_ref().to_string()));
    encode_corewriter_action(ACTION_ADD_API_WALLET, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_api_wallet_action_has_version_and_action_id_prefix() {
        let agent: Address = "0x0000000000000000000000000000000000000a91"
            .parse()
            .unwrap();

        let encoded = encode_add_api_wallet_action(agent, "bot-1").unwrap();

        assert_eq!(&encoded[..4], &[0x01, 0x00, 0x00, 0x09]);
        assert!(encoded.len() > 4);
    }

    #[test]
    fn rejects_action_ids_larger_than_three_bytes() {
        let err = encode_corewriter_action(0x0100_0000, vec![])
            .expect_err("oversized action id should fail");

        assert!(err.contains("exceeds 3 bytes"));
    }
}
