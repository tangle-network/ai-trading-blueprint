//! Registration payload for trading blueprint operators.
//!
//! Encodes operator metadata as TLV (Type-Length-Value) fields that the
//! Blueprint Manager writes to `registration_inputs.bin` during the
//! pre-registration flow.

/// TLV type: operator max capacity (u32 big-endian, 4 bytes)
const TLV_MAX_CAPACITY: u8 = 0x01;
/// TLV type: operator API endpoint (UTF-8 string)
const TLV_API_ENDPOINT: u8 = 0x02;
/// TLV type: supported strategies (UTF-8 comma-separated string)
const TLV_SUPPORTED_STRATEGIES: u8 = 0x03;

fn write_tlv(buf: &mut Vec<u8>, tlv_type: u8, value: &[u8]) {
    buf.push(tlv_type);
    let len = u16::try_from(value.len()).unwrap_or(u16::MAX);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(value);
}

/// Build a TLV-encoded registration payload for a trading blueprint operator.
pub fn trading_registration_payload(
    max_capacity: u32,
    api_endpoint: &str,
    supported_strategies: &str,
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(32 + api_endpoint.len() + supported_strategies.len());
    write_tlv(&mut payload, TLV_MAX_CAPACITY, &max_capacity.to_be_bytes());
    if !api_endpoint.is_empty() {
        write_tlv(&mut payload, TLV_API_ENDPOINT, api_endpoint.as_bytes());
    }
    if !supported_strategies.is_empty() {
        write_tlv(
            &mut payload,
            TLV_SUPPORTED_STRATEGIES,
            supported_strategies.as_bytes(),
        );
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roundtrip_full_payload() {
        let payload = trading_registration_payload(10, "http://localhost:9200", "momentum,mean_reversion");

        let mut pos = 0;

        // Field 1: max_capacity
        assert_eq!(payload[pos], TLV_MAX_CAPACITY);
        pos += 1;
        let len = u16::from_be_bytes([payload[pos], payload[pos + 1]]) as usize;
        pos += 2;
        assert_eq!(len, 4);
        let cap = u32::from_be_bytes(payload[pos..pos + 4].try_into().unwrap());
        assert_eq!(cap, 10);
        pos += len;

        // Field 2: api_endpoint
        assert_eq!(payload[pos], TLV_API_ENDPOINT);
        pos += 1;
        let len = u16::from_be_bytes([payload[pos], payload[pos + 1]]) as usize;
        pos += 2;
        let endpoint = std::str::from_utf8(&payload[pos..pos + len]).unwrap();
        assert_eq!(endpoint, "http://localhost:9200");
        pos += len;

        // Field 3: supported_strategies
        assert_eq!(payload[pos], TLV_SUPPORTED_STRATEGIES);
        pos += 1;
        let len = u16::from_be_bytes([payload[pos], payload[pos + 1]]) as usize;
        pos += 2;
        let strategies = std::str::from_utf8(&payload[pos..pos + len]).unwrap();
        assert_eq!(strategies, "momentum,mean_reversion");
        pos += len;

        assert_eq!(pos, payload.len());
    }

    #[test]
    fn test_empty_optional_fields() {
        let payload = trading_registration_payload(5, "", "");
        // Should only contain max_capacity (1 + 2 + 4 = 7 bytes)
        assert_eq!(payload.len(), 7);
        assert_eq!(payload[0], TLV_MAX_CAPACITY);
    }

    #[test]
    fn test_capacity_encoding() {
        let payload = trading_registration_payload(256, "", "");
        // Skip type (1) + length (2), read 4-byte BE u32
        let cap = u32::from_be_bytes(payload[3..7].try_into().unwrap());
        assert_eq!(cap, 256);
    }
}
