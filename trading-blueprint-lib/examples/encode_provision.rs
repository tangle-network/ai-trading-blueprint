use alloy::primitives::{Address, U256};
use alloy::sol_types::SolValue;
use trading_blueprint_lib::TradingProvisionRequest;

fn main() {
    let request = TradingProvisionRequest {
        name: "polymarket-prediction-bot".to_string(),
        strategy_type: "prediction".to_string(),
        strategy_config_json: r#"{"protocol":"polymarket","max_position_size":1000,"market_types":["binary"]}"#.to_string(),
        risk_params_json: r#"{"max_drawdown_pct":10.0,"max_single_bet":500,"stop_loss_pct":15.0}"#.to_string(),
        env_json: r#"{"OPENCODE_MODEL_PROVIDER":"anthropic","OPENCODE_MODEL_NAME":"claude-haiku-4-5","OPENCODE_MODEL_API_KEY":"YOUR_ANTHROPIC_KEY","ANTHROPIC_API_KEY":"YOUR_ANTHROPIC_KEY","POLYMARKET_API_KEY":"YOUR_POLYMARKET_KEY","POLYMARKET_API_SECRET":"YOUR_POLYMARKET_SECRET","POLYMARKET_API_PASSPHRASE":"YOUR_POLYMARKET_PASSPHRASE"}"#.to_string(),
        factory_address: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa".parse::<Address>().unwrap(),
        asset_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".parse::<Address>().unwrap(),
        signers: vec!["0x70997970C51812dc3A010C7d01b50e0d17dc79C8".parse::<Address>().unwrap()],
        required_signatures: U256::from(1),
        chain_id: U256::from(31337),
        rpc_url: "http://localhost:34095".to_string(),
        trading_loop_cron: "0 */2 * * * *".to_string(),
        cpu_cores: 2,
        memory_mb: 4096,
        max_lifetime_days: 30,
        validator_service_ids: vec![],
    };

    let encoded = request.abi_encode();
    println!("{}", hex::encode(&encoded));
}
