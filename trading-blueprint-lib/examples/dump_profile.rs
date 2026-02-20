//! Dump the agent profile JSON for a given strategy pack.
//!
//! Usage:
//!   cargo run --example dump_profile -p trading-blueprint-lib -- <strategy_type>
//!
//! Example:
//!   cargo run --example dump_profile -p trading-blueprint-lib -- perp > /tmp/perp-profile.json

use trading_blueprint_lib::prompts::packs::get_pack;
use trading_blueprint_lib::state::TradingBotRecord;

fn main() {
    let strategy = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!(
            "Usage: dump_profile <strategy_type>\n\
             Available: prediction, prediction_politics, prediction_crypto,\n\
             prediction_war, prediction_trending, prediction_celebrity,\n\
             dex, yield, perp, volatility, mm, multi"
        );
        std::process::exit(1);
    });

    let pack = get_pack(&strategy).unwrap_or_else(|| {
        eprintln!("Unknown strategy type: {strategy}");
        std::process::exit(1);
    });

    let config = TradingBotRecord {
        id: "dump".to_string(),
        sandbox_id: "dump".to_string(),
        vault_address: "0x0000000000000000000000000000000000000000".to_string(),
        share_token: String::new(),
        strategy_type: strategy.clone(),
        strategy_config: serde_json::json!({"paper_trade": true}),
        risk_params: serde_json::json!({
            "max_position_pct": 10.0,
            "max_drawdown_pct": 5.0
        }),
        chain_id: 31337,
        rpc_url: "http://localhost:8545".to_string(),
        trading_api_url: "http://host.docker.internal:9200".to_string(),
        trading_api_token: "e7ee341487dace13f03db3ea4b412ff2b58896b646ed60acacaba95da33af3b0"
            .to_string(),
        workflow_id: None,
        trading_active: true,
        created_at: 0,
        operator_address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8".to_string(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: String::new(),
        trading_loop_cron: String::new(),
        call_id: 0,
        service_id: 0,
    };

    let profile = pack.build_agent_profile(&config);
    let json = serde_json::to_string_pretty(&profile).expect("failed to serialize profile");
    println!("{json}");
}
