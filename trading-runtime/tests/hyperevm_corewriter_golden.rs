use alloy::primitives::Address;
use trading_runtime::hyperevm_corewriter::{
    encode_add_api_wallet_action, encode_spot_send_action, encode_usd_class_transfer_action,
};

fn golden_add_api_wallet_action() -> Vec<u8> {
    hex::decode(concat!(
        "01000009",
        "0000000000000000000000000000000000000000000000000000000000000a91",
        "0000000000000000000000000000000000000000000000000000000000000040",
        "0000000000000000000000000000000000000000000000000000000000000005",
        "626f742d31000000000000000000000000000000000000000000000000000000",
    ))
    .unwrap()
}

fn golden_usd_class_transfer_action() -> Vec<u8> {
    hex::decode(concat!(
        "01000007",
        "00000000000000000000000000000000000000000000000000000000000f4240",
        "0000000000000000000000000000000000000000000000000000000000000000",
    ))
    .unwrap()
}

fn golden_spot_send_action() -> Vec<u8> {
    hex::decode(concat!(
        "01000006",
        "0000000000000000000000000000000000000000000000000000000000000a91",
        "00000000000000000000000000000000000000000000000000000000000005e1",
        "00000000000000000000000000000000000000000000000000000000001e8480",
    ))
    .unwrap()
}

#[test]
fn add_api_wallet_action_matches_full_payload_golden_vector() {
    let agent: Address = "0x0000000000000000000000000000000000000a91"
        .parse()
        .unwrap();

    let encoded = encode_add_api_wallet_action(agent, "bot-1").unwrap();

    assert_eq!(encoded.as_ref(), golden_add_api_wallet_action().as_slice());
}

#[test]
fn usd_class_transfer_action_matches_full_payload_golden_vector() {
    let encoded = encode_usd_class_transfer_action(1_000_000, false).unwrap();

    assert_eq!(
        encoded.as_ref(),
        golden_usd_class_transfer_action().as_slice()
    );
}

#[test]
fn spot_send_action_matches_full_payload_golden_vector() {
    let destination: Address = "0x0000000000000000000000000000000000000a91"
        .parse()
        .unwrap();

    let encoded = encode_spot_send_action(destination, 1_505, 2_000_000).unwrap();

    assert_eq!(encoded.as_ref(), golden_spot_send_action().as_slice());
}
