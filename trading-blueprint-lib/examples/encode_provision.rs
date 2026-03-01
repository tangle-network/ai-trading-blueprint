use alloy::primitives::{Address, U256};
use alloy::sol_types::SolValue;
use trading_blueprint_lib::TradingProvisionRequest;

fn main() {
    let request = TradingProvisionRequest {
        name: "Polymarket Paper Trader".to_string(),
        strategy_type: "prediction".to_string(),
        strategy_config_json:
            r#"{"protocol":"polymarket","max_position_size":1000,"market_types":["binary"]}"#
                .to_string(),
        risk_params_json: r#"{"max_drawdown_pct":10.0,"max_single_bet":500,"stop_loss_pct":15.0}"#
            .to_string(),
        factory_address: "0xccf1769D8713099172642EB55DDFFC0c5A444FE9"
            .parse::<Address>()
            .unwrap(),
        asset_token: "0xE8addD62feD354203d079926a8e563BC1A7FE81e"
            .parse::<Address>()
            .unwrap(),
        signers: vec![],
        required_signatures: U256::from(0),
        chain_id: U256::from(31337),
        rpc_url: "http://localhost:8545".to_string(),
        trading_loop_cron: "0 */2 * * * *".to_string(),
        cpu_cores: 2,
        memory_mb: 4096,
        max_lifetime_days: 30,
        validator_service_ids: vec![],
        max_collateral_bps: U256::from(0),
    };

    let encoded = request.abi_encode();
    println!("{}", hex::encode(&encoded));
}
