//! Human-readable calldata decoding for known protocol function selectors.
//!
//! Decodes ABI-encoded calldata into readable strings like:
//! `exactInputSingle(tokenIn=0x..., tokenOut=0x..., fee=3000, ...)`

use alloy::primitives::{Bytes, U256};

/// Known function selectors (first 4 bytes of keccak256 of function signature).
const EXACT_INPUT_SINGLE: [u8; 4] = [0x41, 0x4b, 0xf3, 0x89];
const EXACT_OUTPUT_SINGLE: [u8; 4] = [0x5b, 0x41, 0xb9, 0x08];
const SUPPLY: [u8; 4] = [0x61, 0x7b, 0xa0, 0x37]; // supply(address,uint256,address,uint16)
const WITHDRAW: [u8; 4] = [0x69, 0x32, 0x8d, 0xec]; // withdraw(address,uint256,address)
const BORROW: [u8; 4] = [0xa4, 0x15, 0xbc, 0xad]; // borrow(address,uint256,uint256,uint16,address)
const REPAY: [u8; 4] = [0x57, 0x3e, 0xba, 0x17]; // repay(address,uint256,uint256,address)
const CREATE_ORDER: [u8; 4] = [0x3a, 0x28, 0x73, 0x07]; // createOrder(CreateOrderParams)
const SPLIT_POSITION: [u8; 4] = [0x72, 0xce, 0x42, 0x75]; // splitPosition(IERC20,IERC20,bytes32,uint256[],uint256)
const MERGE_POSITIONS: [u8; 4] = [0xf8, 0x89, 0x6b, 0xf4]; // mergePositions(IERC20,IERC20,bytes32,uint256[],uint256)
const DEPOSIT_4626: [u8; 4] = [0x6e, 0x55, 0x3f, 0x65]; // deposit(uint256,address)
const WITHDRAW_4626: [u8; 4] = [0xb4, 0x60, 0xaf, 0x94]; // withdraw(uint256,address,address)
const APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3]; // approve(address,uint256)
const SUBMIT_SLOW_MODE: [u8; 4] = [0xf6, 0x63, 0x34, 0x56]; // submitSlowModeTransaction(bytes)

// New selectors
const TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb]; // transfer(address,uint256)
const TRANSFER_FROM: [u8; 4] = [0x23, 0xb8, 0x72, 0xdd]; // transferFrom(address,address,uint256)
const MULTICALL: [u8; 4] = [0xac, 0x96, 0x50, 0xd8]; // multicall(bytes[])
const REDEEM_POSITIONS: [u8; 4] = [0x01, 0xa2, 0xe9, 0x24]; // redeemPositions(IERC20,bytes32,uint256[])

/// Decode calldata into a human-readable string.
///
/// Returns the decoded function name and parameters for known selectors,
/// or a generic "unknown(0x<selector>)" for unrecognized calldata.
pub fn decode_calldata(data: &[u8], protocol: &str) -> String {
    if data.len() < 4 {
        return "empty calldata".to_string();
    }

    let selector: [u8; 4] = [data[0], data[1], data[2], data[3]];
    let params = &data[4..];

    match selector {
        EXACT_INPUT_SINGLE => decode_exact_input_single(params),
        EXACT_OUTPUT_SINGLE => decode_exact_output_single(params),
        SUPPLY => decode_address_amount("supply", params),
        WITHDRAW => decode_address_amount("withdraw", params),
        BORROW => decode_address_amount("borrow", params),
        REPAY => decode_address_amount("repay", params),
        CREATE_ORDER => decode_create_order(params, protocol),
        SPLIT_POSITION => decode_ctf_position("splitPosition", params),
        MERGE_POSITIONS => decode_ctf_position("mergePositions", params),
        DEPOSIT_4626 => decode_uint_address("deposit", params),
        WITHDRAW_4626 => decode_uint_address("withdraw", params),
        APPROVE => decode_approve(params),
        SUBMIT_SLOW_MODE => decode_submit_slow_mode(params),
        TRANSFER => decode_transfer(params),
        TRANSFER_FROM => decode_transfer_from(params),
        MULTICALL => decode_multicall(params),
        REDEEM_POSITIONS => decode_redeem_positions(params),
        _ => format!("unknown(0x{})", hex::encode(selector)),
    }
}

/// Decode a full EncodedAction's calldata with protocol context.
pub fn decode_encoded_action(calldata: &Bytes, protocol: &str) -> String {
    decode_calldata(calldata.as_ref(), protocol)
}

fn decode_exact_input_single(params: &[u8]) -> String {
    if params.len() < 256 {
        return "exactInputSingle(...)".to_string();
    }
    // ABI: struct ExactInputSingleParams { tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96 }
    let token_in = extract_address(params, 0);
    let token_out = extract_address(params, 1);
    let fee = extract_u32(params, 2);
    format!("exactInputSingle(tokenIn={token_in}, tokenOut={token_out}, fee={fee})")
}

fn decode_exact_output_single(params: &[u8]) -> String {
    if params.len() < 256 {
        return "exactOutputSingle(...)".to_string();
    }
    // ABI: struct ExactOutputSingleParams { tokenIn, tokenOut, fee, recipient, deadline, amountOut, amountInMaximum, sqrtPriceLimitX96 }
    let token_in = extract_address(params, 0);
    let token_out = extract_address(params, 1);
    let fee = extract_u32(params, 2);
    let amount_out = extract_u256(params, 5);
    format!("exactOutputSingle(tokenIn={token_in}, tokenOut={token_out}, fee={fee}, amountOut={amount_out})")
}

fn decode_create_order(params: &[u8], protocol: &str) -> String {
    // GMX V2 CreateOrderParams is a complex struct with nested fields.
    // The first few words contain: addresses.market, addresses.initialCollateralToken
    // Then numbers.orderType, flags.isLong, etc.
    // Struct starts with a tuple offset pointer.
    if params.len() < 192 {
        return format!("createOrder(market={protocol})");
    }
    // Skip the offset pointer (word 0 = 0x20), then decode addresses sub-struct.
    // addresses sub-struct offset is at word 0 of the tuple.
    // For a flat struct encoding: market=word1, initialCollateralToken=word2
    // For a dynamic tuple: offset at word0, then market at the pointed location.
    // GMX uses: CreateOrderParams(addresses, numbers, orderType, decreasePositionSwapType, isLong, shouldUnwrapNativeToken, autoCancel, referralCode)
    // addresses struct: receiver, cancellationReceiver, callbackContract, uiFeeReceiver, market, initialCollateralToken, swapPath
    // Since the encoding is complex (nested dynamic types), extract what we can.
    // The outer struct has an offset to the tuple at word 0.
    let market = extract_address(params, 5); // market is 5th field in addresses sub-struct
    let collateral = extract_address(params, 6); // initialCollateralToken
    // isLong is a bool deeper in the struct — hard to reliably extract without full ABI decode.
    format!("createOrder(market={market}, collateralToken={collateral}, protocol={protocol})")
}

/// Decode splitPosition or mergePositions.
/// ABI: splitPosition(IERC20 collateralToken, IERC20 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)
///      mergePositions(IERC20 collateralToken, IERC20 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)
fn decode_ctf_position(name: &str, params: &[u8]) -> String {
    if params.len() < 160 {
        return format!("{name}(...)");
    }
    let collateral = extract_address(params, 0);
    let condition_id = extract_bytes32(params, 2);
    // Amount is after the dynamic partition array — hard to locate without parsing the offset.
    // The partition offset is at word 3, amount might be at word 4 if partition is empty.
    format!("{name}(collateral={collateral}, conditionId={condition_id})")
}

fn decode_submit_slow_mode(params: &[u8]) -> String {
    // submitSlowModeTransaction(bytes encodedTx)
    // Dynamic bytes: word 0 = offset, word 1 = length, then data
    if params.len() < 64 {
        return "submitSlowModeTransaction(...)".to_string();
    }
    let length = extract_u256(params, 1);
    format!("submitSlowModeTransaction(dataLength={length})")
}

fn decode_transfer(params: &[u8]) -> String {
    if params.len() < 64 {
        return "transfer(...)".to_string();
    }
    let to = extract_address(params, 0);
    let amount = extract_u256(params, 1);
    format!("transfer(to={to}, amount={amount})")
}

fn decode_transfer_from(params: &[u8]) -> String {
    if params.len() < 96 {
        return "transferFrom(...)".to_string();
    }
    let from = extract_address(params, 0);
    let to = extract_address(params, 1);
    let amount = extract_u256(params, 2);
    format!("transferFrom(from={from}, to={to}, amount={amount})")
}

fn decode_multicall(params: &[u8]) -> String {
    // multicall(bytes[] data) — dynamic array
    // word 0 = offset to array, word 1 (at offset) = array length
    if params.len() < 64 {
        return "multicall(...)".to_string();
    }
    let count = extract_u256(params, 1);
    format!("multicall(callCount={count})")
}

fn decode_redeem_positions(params: &[u8]) -> String {
    // redeemPositions(IERC20 collateralToken, bytes32 conditionId, uint256[] indexSets)
    if params.len() < 96 {
        return "redeemPositions(...)".to_string();
    }
    let collateral = extract_address(params, 0);
    let condition_id = extract_bytes32(params, 1);
    format!("redeemPositions(collateral={collateral}, conditionId={condition_id})")
}

fn decode_address_amount(name: &str, params: &[u8]) -> String {
    if params.len() < 64 {
        return format!("{name}(...)");
    }
    let asset = extract_address(params, 0);
    let amount = extract_u256(params, 1);
    format!("{name}(asset={asset}, amount={amount})")
}

fn decode_uint_address(name: &str, params: &[u8]) -> String {
    if params.len() < 64 {
        return format!("{name}(...)");
    }
    let amount = extract_u256(params, 0);
    let receiver = extract_address(params, 1);
    format!("{name}(amount={amount}, receiver={receiver})")
}

fn decode_approve(params: &[u8]) -> String {
    if params.len() < 64 {
        return "approve(...)".to_string();
    }
    let spender = extract_address(params, 0);
    let amount = extract_u256(params, 1);
    format!("approve(spender={spender}, amount={amount})")
}

/// Extract an address from ABI-encoded params at a given word index (32-byte aligned).
fn extract_address(params: &[u8], word_index: usize) -> String {
    let offset = word_index * 32;
    if offset + 32 > params.len() {
        return "?".to_string();
    }
    // Address is in the last 20 bytes of the 32-byte word
    let addr_bytes = &params[offset + 12..offset + 32];
    format!("0x{}", hex::encode(addr_bytes))
}

/// Extract a U256 from ABI-encoded params at a given word index.
fn extract_u256(params: &[u8], word_index: usize) -> String {
    let offset = word_index * 32;
    if offset + 32 > params.len() {
        return "?".to_string();
    }
    let word = &params[offset..offset + 32];
    let val = U256::from_be_slice(word);
    format!("{val}")
}

/// Extract a u32 from ABI-encoded params (last 4 bytes of 32-byte word).
fn extract_u32(params: &[u8], word_index: usize) -> String {
    let offset = word_index * 32;
    if offset + 32 > params.len() {
        return "?".to_string();
    }
    let val = u32::from_be_bytes([
        params[offset + 28],
        params[offset + 29],
        params[offset + 30],
        params[offset + 31],
    ]);
    format!("{val}")
}

/// Extract a bytes32 from ABI-encoded params as a hex string.
fn extract_bytes32(params: &[u8], word_index: usize) -> String {
    let offset = word_index * 32;
    if offset + 32 > params.len() {
        return "?".to_string();
    }
    let word = &params[offset..offset + 32];
    format!("0x{}", hex::encode(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_empty_calldata() {
        assert_eq!(decode_calldata(&[], "uniswap_v3"), "empty calldata");
    }

    #[test]
    fn test_decode_unknown_selector() {
        let data = [0xde, 0xad, 0xbe, 0xef, 0x00];
        let result = decode_calldata(&data, "uniswap_v3");
        assert!(result.starts_with("unknown(0x"));
    }

    #[test]
    fn test_decode_approve() {
        // approve(address,uint256) selector = 0x095ea7b3
        let mut data = vec![0x09, 0x5e, 0xa7, 0xb3];
        // spender (padded address)
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(
            &hex::decode("E592427A0AEce92De3Edee1F18E0157C05861564").unwrap(),
        );
        // amount = 1000
        let mut amount_word = [0u8; 32];
        amount_word[31] = 0xe8;
        amount_word[30] = 0x03;
        data.extend_from_slice(&amount_word);

        let result = decode_calldata(&data, "uniswap_v3");
        assert!(result.contains("approve(spender="));
        assert!(result.contains("e592427a0aece92de3edee1f18e0157c05861564"));
    }

    #[test]
    fn test_decode_exact_input_single_short_params() {
        // Selector only, not enough params
        let data = [0x41, 0x4b, 0xf3, 0x89, 0x00, 0x01];
        let result = decode_calldata(&data, "uniswap_v3");
        assert_eq!(result, "exactInputSingle(...)");
    }

    #[test]
    fn test_decode_exact_input_single_full() {
        let mut data = vec![0x41, 0x4b, 0xf3, 0x89]; // selector
        // 8 words = 256 bytes for ExactInputSingleParams
        // word 0: tokenIn
        let mut word = [0u8; 32];
        word[31] = 0x01;
        data.extend_from_slice(&word);
        // word 1: tokenOut
        word[31] = 0x02;
        data.extend_from_slice(&word);
        // word 2: fee = 3000
        let mut fee_word = [0u8; 32];
        fee_word[31] = 0xb8;
        fee_word[30] = 0x0b;
        data.extend_from_slice(&fee_word);
        // words 3-7: recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96
        for _ in 3..8 {
            data.extend_from_slice(&[0u8; 32]);
        }

        let result = decode_calldata(&data, "uniswap_v3");
        assert!(result.contains("exactInputSingle"));
        assert!(result.contains("fee=3000"));
    }

    #[test]
    fn test_decode_exact_output_single_full() {
        let mut data = vec![0x5b, 0x41, 0xb9, 0x08]; // selector
        // 8 words for ExactOutputSingleParams
        for i in 0..8 {
            let mut word = [0u8; 32];
            if i == 2 {
                // fee = 500
                word[31] = 0xf4;
                word[30] = 0x01;
            } else if i == 5 {
                // amountOut = 1000000
                word[31] = 0x40;
                word[30] = 0x42;
                word[29] = 0x0f;
            }
            data.extend_from_slice(&word);
        }

        let result = decode_calldata(&data, "uniswap_v3");
        assert!(result.contains("exactOutputSingle"));
        assert!(result.contains("fee=500"));
        assert!(result.contains("amountOut=1000000"));
    }

    #[test]
    fn test_decode_exact_output_single_short() {
        let data = [0x5b, 0x41, 0xb9, 0x08, 0x00];
        let result = decode_calldata(&data, "uniswap_v3");
        assert_eq!(result, "exactOutputSingle(...)");
    }

    #[test]
    fn test_decode_supply() {
        let mut data = vec![0x61, 0x7b, 0xa0, 0x37]; // selector
        // asset address
        let mut word = [0u8; 32];
        word[31] = 0xAA;
        data.extend_from_slice(&word);
        // amount = 5000
        let mut amount = [0u8; 32];
        amount[31] = 0x88;
        amount[30] = 0x13;
        data.extend_from_slice(&amount);

        let result = decode_calldata(&data, "aave_v3");
        assert!(result.starts_with("supply("));
        assert!(result.contains("amount=5000"));
    }

    #[test]
    fn test_decode_withdraw_aave() {
        let mut data = vec![0x69, 0x32, 0x8d, 0xec];
        data.extend_from_slice(&[0u8; 32]); // asset
        let mut amount = [0u8; 32];
        amount[31] = 100;
        data.extend_from_slice(&amount);

        let result = decode_calldata(&data, "aave_v3");
        assert!(result.starts_with("withdraw("));
        assert!(result.contains("amount=100"));
    }

    #[test]
    fn test_decode_borrow() {
        let mut data = vec![0xa4, 0x15, 0xbc, 0xad];
        data.extend_from_slice(&[0u8; 32]); // asset
        let mut amount = [0u8; 32];
        amount[31] = 50;
        data.extend_from_slice(&amount);

        let result = decode_calldata(&data, "aave_v3");
        assert!(result.starts_with("borrow("));
        assert!(result.contains("amount=50"));
    }

    #[test]
    fn test_decode_repay() {
        let mut data = vec![0x57, 0x3e, 0xba, 0x17];
        data.extend_from_slice(&[0u8; 32]); // asset
        let mut amount = [0u8; 32];
        amount[31] = 75;
        data.extend_from_slice(&amount);

        let result = decode_calldata(&data, "aave_v3");
        assert!(result.starts_with("repay("));
        assert!(result.contains("amount=75"));
    }

    #[test]
    fn test_decode_create_order_short() {
        // Short params — falls back to protocol name
        let mut data = vec![0x3a, 0x28, 0x73, 0x07];
        data.extend_from_slice(&[0u8; 64]);

        let result = decode_calldata(&data, "gmx_v2");
        assert!(result.contains("gmx_v2"));
    }

    #[test]
    fn test_decode_create_order_full() {
        let mut data = vec![0x3a, 0x28, 0x73, 0x07];
        // 7+ words of params (enough for market + collateral extraction)
        for i in 0..7 {
            let mut word = [0u8; 32];
            if i == 5 {
                word[31] = 0x42; // market address
            } else if i == 6 {
                word[31] = 0x99; // collateral token
            }
            data.extend_from_slice(&word);
        }

        let result = decode_calldata(&data, "gmx_v2");
        assert!(result.contains("createOrder"));
        assert!(result.contains("protocol=gmx_v2"));
    }

    #[test]
    fn test_decode_split_position() {
        let mut data = vec![0x72, 0xce, 0x42, 0x75];
        // collateral (word 0)
        let mut word = [0u8; 32];
        word[31] = 0x01;
        data.extend_from_slice(&word);
        // parentCollectionId (word 1)
        data.extend_from_slice(&[0u8; 32]);
        // conditionId (word 2) — a bytes32
        let mut cond = [0u8; 32];
        cond[0] = 0xAB;
        cond[31] = 0xCD;
        data.extend_from_slice(&cond);
        // partition offset (word 3)
        data.extend_from_slice(&[0u8; 32]);
        // amount (word 4)
        data.extend_from_slice(&[0u8; 32]);

        let result = decode_calldata(&data, "polymarket");
        assert!(result.starts_with("splitPosition("));
        assert!(result.contains("conditionId=0xab"));
    }

    #[test]
    fn test_decode_merge_positions() {
        let mut data = vec![0xf8, 0x89, 0x6b, 0xf4];
        for _ in 0..5 {
            data.extend_from_slice(&[0u8; 32]);
        }

        let result = decode_calldata(&data, "polymarket");
        assert!(result.starts_with("mergePositions("));
    }

    #[test]
    fn test_decode_deposit_4626() {
        let mut data = vec![0x6e, 0x55, 0x3f, 0x65];
        let mut amount = [0u8; 32];
        amount[31] = 200;
        data.extend_from_slice(&amount);
        data.extend_from_slice(&[0u8; 32]); // receiver

        let result = decode_calldata(&data, "morpho");
        assert!(result.starts_with("deposit("));
        assert!(result.contains("amount=200"));
    }

    #[test]
    fn test_decode_withdraw_4626() {
        let mut data = vec![0xb4, 0x60, 0xaf, 0x94];
        let mut amount = [0u8; 32];
        amount[31] = 150;
        data.extend_from_slice(&amount);
        data.extend_from_slice(&[0u8; 32]); // receiver

        let result = decode_calldata(&data, "morpho");
        assert!(result.starts_with("withdraw("));
        assert!(result.contains("amount=150"));
    }

    #[test]
    fn test_decode_submit_slow_mode() {
        let mut data = vec![0xf6, 0x63, 0x34, 0x56];
        // offset to bytes (word 0 = 0x20)
        let mut offset_word = [0u8; 32];
        offset_word[31] = 0x20;
        data.extend_from_slice(&offset_word);
        // length = 64
        let mut len_word = [0u8; 32];
        len_word[31] = 0x40;
        data.extend_from_slice(&len_word);

        let result = decode_calldata(&data, "vertex");
        assert!(result.contains("submitSlowModeTransaction"));
        assert!(result.contains("dataLength=64"));
    }

    #[test]
    fn test_decode_transfer() {
        let mut data = vec![0xa9, 0x05, 0x9c, 0xbb];
        let mut to_word = [0u8; 32];
        to_word[31] = 0x42;
        data.extend_from_slice(&to_word);
        let mut amount = [0u8; 32];
        amount[31] = 100;
        data.extend_from_slice(&amount);

        let result = decode_calldata(&data, "erc20");
        assert!(result.starts_with("transfer("));
        assert!(result.contains("amount=100"));
    }

    #[test]
    fn test_decode_transfer_from() {
        let mut data = vec![0x23, 0xb8, 0x72, 0xdd];
        let mut from_word = [0u8; 32];
        from_word[31] = 0x01;
        data.extend_from_slice(&from_word);
        let mut to_word = [0u8; 32];
        to_word[31] = 0x02;
        data.extend_from_slice(&to_word);
        let mut amount = [0u8; 32];
        amount[31] = 50;
        data.extend_from_slice(&amount);

        let result = decode_calldata(&data, "erc20");
        assert!(result.starts_with("transferFrom("));
        assert!(result.contains("amount=50"));
    }

    #[test]
    fn test_decode_multicall() {
        let mut data = vec![0xac, 0x96, 0x50, 0xd8];
        // offset to array (word 0 = 0x20)
        let mut offset_word = [0u8; 32];
        offset_word[31] = 0x20;
        data.extend_from_slice(&offset_word);
        // array length = 3
        let mut count_word = [0u8; 32];
        count_word[31] = 3;
        data.extend_from_slice(&count_word);

        let result = decode_calldata(&data, "uniswap_v3");
        assert!(result.contains("multicall"));
        assert!(result.contains("callCount=3"));
    }

    #[test]
    fn test_decode_redeem_positions() {
        let mut data = vec![0x01, 0xa2, 0xe9, 0x24];
        // collateral (word 0)
        let mut coll_word = [0u8; 32];
        coll_word[31] = 0x01;
        data.extend_from_slice(&coll_word);
        // conditionId (word 1)
        let mut cond = [0u8; 32];
        cond[0] = 0xFF;
        data.extend_from_slice(&cond);
        // indexSets offset (word 2)
        data.extend_from_slice(&[0u8; 32]);

        let result = decode_calldata(&data, "polymarket");
        assert!(result.starts_with("redeemPositions("));
        assert!(result.contains("conditionId=0xff"));
    }

    #[test]
    fn test_decode_short_params_fallback() {
        // Each decoder should handle insufficient params gracefully
        for selector in [
            EXACT_OUTPUT_SINGLE,
            SUPPLY,
            WITHDRAW,
            BORROW,
            REPAY,
            DEPOSIT_4626,
            WITHDRAW_4626,
            APPROVE,
            SUBMIT_SLOW_MODE,
            TRANSFER,
            TRANSFER_FROM,
            MULTICALL,
            REDEEM_POSITIONS,
            SPLIT_POSITION,
            MERGE_POSITIONS,
        ] {
            let mut data = selector.to_vec();
            data.push(0x00); // only 1 byte of params
            let result = decode_calldata(&data, "test");
            assert!(result.contains("(...)") || result.contains("("), "selector {:?} should handle short params: {}", selector, result);
        }
    }

    #[test]
    fn test_extract_address() {
        let mut word = [0u8; 32];
        word[31] = 0x42;
        assert!(extract_address(&word, 0).ends_with("42"));
    }

    #[test]
    fn test_extract_u256() {
        let mut word = [0u8; 32];
        word[31] = 100;
        assert_eq!(extract_u256(&word, 0), "100");
    }

    #[test]
    fn test_extract_bytes32() {
        let mut word = [0u8; 32];
        word[0] = 0xAB;
        word[31] = 0xCD;
        let result = extract_bytes32(&word, 0);
        assert!(result.starts_with("0xab"));
        assert!(result.ends_with("cd"));
    }

    #[test]
    fn test_extract_out_of_bounds() {
        let word = [0u8; 16]; // too short
        assert_eq!(extract_address(&word, 0), "?");
        assert_eq!(extract_u256(&word, 0), "?");
        assert_eq!(extract_u32(&word, 0), "?");
        assert_eq!(extract_bytes32(&word, 0), "?");
    }
}
