//! Test ABI decode of provision request.
//!
//! Usage:
//!   cargo run --example test_decode -p trading-blueprint-lib

use alloy::sol_types::SolValue;
use trading_blueprint_lib::TradingProvisionRequest;

fn main() {
    let hex_str = "00000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000ccf1769d8713099172642eb55ddffc0c5a444fe9000000000000000000000000e8addd62fed354203d079926a8e563bc1a7fe81e000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000007a690000000000000000000000000000000000000000000000000000000000000340000000000000000000000000000000000000000000000000000000000000036000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000000000000000000000000000000000000000001150657270205061706572205472616465720000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004706572700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000147b2270617065725f7472616465223a747275657d000000000000000000000000000000000000000000000000000000000000000000000000000000000000002c7b226d61785f706f736974696f6e5f706374223a31302c226d61785f64726177646f776e5f706374223a357d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb922660000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d30202a2f32202a202a202a202a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    let bytes = hex::decode(hex_str).expect("invalid hex");
    println!("Input length: {} bytes", bytes.len());

    // Try abi_decode (what TangleArg uses)
    match TradingProvisionRequest::abi_decode(&bytes) {
        Ok(req) => {
            println!("abi_decode SUCCESS!");
            println!("  name: {}", req.name);
            println!("  strategy_type: {}", req.strategy_type);
            println!("  chain_id: {}", req.chain_id);
            println!("  trading_loop_cron: {}", req.trading_loop_cron);
        }
        Err(e) => {
            println!("abi_decode FAILED: {:?}", e);
        }
    }

    // Try abi_decode_sequence
    match <TradingProvisionRequest as SolValue>::abi_decode_sequence(&bytes) {
        Ok(req) => {
            println!("abi_decode_sequence SUCCESS!");
            println!("  name: {}", req.name);
            println!("  strategy_type: {}", req.strategy_type);
        }
        Err(e) => {
            println!("abi_decode_sequence FAILED: {:?}", e);
        }
    }

    // Encode properly and compare
    let correct = TradingProvisionRequest {
        name: "Perp Paper Trader".into(),
        strategy_type: "perp".into(),
        strategy_config_json: "{\"paper_trade\":true}".into(),
        risk_params_json: "{\"max_position_pct\":10,\"max_drawdown_pct\":5}".into(),
        factory_address: "0xccf1769D8713099172642EB55DDFFC0c5A444FE9"
            .parse()
            .unwrap(),
        asset_token: "0xE8addD62feD354203d079926a8e563BC1A7FE81e"
            .parse()
            .unwrap(),
        signers: vec!["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
            .parse()
            .unwrap()],
        required_signatures: alloy::primitives::U256::from(1),
        chain_id: alloy::primitives::U256::from(31337u64),
        rpc_url: "".into(),
        trading_loop_cron: "0 */2 * * * *".into(),
        cpu_cores: 2,
        memory_mb: 2048,
        max_lifetime_days: 30,
        validator_service_ids: vec![],
    };

    let encoded = correct.abi_encode();
    println!("\nCorrect abi_encode length: {} bytes", encoded.len());
    println!("Match input: {}", encoded == bytes);

    if encoded != bytes {
        for (i, (a, b)) in encoded.iter().zip(bytes.iter()).enumerate() {
            if a != b {
                println!(
                    "First diff at byte {}: encoded={:#04x} input={:#04x}",
                    i, a, b
                );
                break;
            }
        }
        if encoded.len() != bytes.len() {
            println!(
                "Length diff: encoded={} input={}",
                encoded.len(),
                bytes.len()
            );
        }
        println!("\nCorrect encoding (hex):\n{}", hex::encode(&encoded));
    }

    let params_encoded = correct.abi_encode_params();
    println!(
        "\nabi_encode_params length: {} bytes",
        params_encoded.len()
    );
    println!("Params match input: {}", params_encoded == bytes);
}
