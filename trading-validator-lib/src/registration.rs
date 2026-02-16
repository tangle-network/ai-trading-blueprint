//! Registration payload for validator blueprint operators.
//!
//! The first 32 bytes are ABI-encoded `uint64 serviceId` — required by
//! `ValidatorBlueprint.sol:onRegister()` which does `abi.decode(inputs, (uint64))`.
//! Additional metadata is appended as TLV fields for off-chain consumption
//! (the contract ignores bytes beyond the first 32).

/// TLV type: chain ID (u64 big-endian, 8 bytes)
const TLV_CHAIN_ID: u8 = 0x01;
/// TLV type: verifying contract address (UTF-8 string)
const TLV_VERIFYING_CONTRACT: u8 = 0x02;
/// TLV type: validator HTTP endpoint (UTF-8 string)
const TLV_VALIDATOR_ENDPOINT: u8 = 0x03;

fn write_tlv(buf: &mut Vec<u8>, tlv_type: u8, value: &[u8]) {
    buf.push(tlv_type);
    let len = u16::try_from(value.len()).unwrap_or(u16::MAX);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(value);
}

/// Build a registration payload for a validator blueprint operator.
///
/// Layout:
/// - Bytes 0..32: ABI-encoded `uint64 serviceId` (right-aligned in 32-byte word)
/// - Bytes 32+: TLV-encoded metadata (chain_id, verifying_contract, endpoint)
pub fn validator_registration_payload(
    service_id: u64,
    chain_id: u64,
    verifying_contract: &str,
    validator_endpoint: &str,
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(64 + verifying_contract.len() + validator_endpoint.len());

    // ABI-encode service_id as uint64 in a 32-byte word (big-endian, right-aligned)
    let mut word = [0u8; 32];
    word[24..32].copy_from_slice(&service_id.to_be_bytes());
    payload.extend_from_slice(&word);

    // TLV metadata
    write_tlv(&mut payload, TLV_CHAIN_ID, &chain_id.to_be_bytes());
    if !verifying_contract.is_empty() {
        write_tlv(
            &mut payload,
            TLV_VERIFYING_CONTRACT,
            verifying_contract.as_bytes(),
        );
    }
    if !validator_endpoint.is_empty() {
        write_tlv(
            &mut payload,
            TLV_VALIDATOR_ENDPOINT,
            validator_endpoint.as_bytes(),
        );
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_abi_encoded_service_id() {
        let payload = validator_registration_payload(42, 1, "", "");

        // First 32 bytes should be ABI-encoded uint64(42)
        assert_eq!(payload.len(), 32 + 1 + 2 + 8); // word + chain_id TLV

        // Bytes 0..24 should be zero padding
        assert!(payload[0..24].iter().all(|&b| b == 0));

        // Bytes 24..32 should be big-endian 42
        let decoded = u64::from_be_bytes(payload[24..32].try_into().unwrap());
        assert_eq!(decoded, 42);
    }

    #[test]
    fn test_roundtrip_full_payload() {
        let payload = validator_registration_payload(
            7,
            31337,
            "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
            "http://0.0.0.0:9090",
        );

        // Parse ABI word
        let service_id = u64::from_be_bytes(payload[24..32].try_into().unwrap());
        assert_eq!(service_id, 7);

        // Parse TLV fields starting at offset 32
        let mut pos = 32;

        // chain_id
        assert_eq!(payload[pos], TLV_CHAIN_ID);
        pos += 1;
        let len = u16::from_be_bytes([payload[pos], payload[pos + 1]]) as usize;
        pos += 2;
        assert_eq!(len, 8);
        let chain_id = u64::from_be_bytes(payload[pos..pos + 8].try_into().unwrap());
        assert_eq!(chain_id, 31337);
        pos += len;

        // verifying_contract
        assert_eq!(payload[pos], TLV_VERIFYING_CONTRACT);
        pos += 1;
        let len = u16::from_be_bytes([payload[pos], payload[pos + 1]]) as usize;
        pos += 2;
        let contract = std::str::from_utf8(&payload[pos..pos + len]).unwrap();
        assert_eq!(contract, "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9");
        pos += len;

        // validator_endpoint
        assert_eq!(payload[pos], TLV_VALIDATOR_ENDPOINT);
        pos += 1;
        let len = u16::from_be_bytes([payload[pos], payload[pos + 1]]) as usize;
        pos += 2;
        let endpoint = std::str::from_utf8(&payload[pos..pos + len]).unwrap();
        assert_eq!(endpoint, "http://0.0.0.0:9090");
        pos += len;

        assert_eq!(pos, payload.len());
    }

    #[test]
    fn test_service_id_zero() {
        let payload = validator_registration_payload(0, 1, "", "");
        // All 32 bytes of the ABI word should be zero
        assert!(payload[0..32].iter().all(|&b| b == 0));
    }

    #[test]
    fn test_large_service_id() {
        let payload = validator_registration_payload(u64::MAX, 1, "", "");
        let decoded = u64::from_be_bytes(payload[24..32].try_into().unwrap());
        assert_eq!(decoded, u64::MAX);
        // Upper padding should still be zero (uint64 fits in 8 bytes)
        assert!(payload[0..24].iter().all(|&b| b == 0));
    }
}
