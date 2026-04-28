use alloy::primitives::{Address, U256};
use std::env;
use trading_blueprint_lib::TradingProvisionRequest;
use trading_blueprint_lib::context::{TradingOperatorContext, init_operator_context};
use trading_blueprint_lib::jobs::provision_core;

fn env_or(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_string())
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    runtime.block_on(async move {
        let service_id: u64 = env_or("SERVICE_ID", "1").parse().expect("SERVICE_ID");
        let call_id: u64 = env_or("CALL_ID", "0").parse().expect("CALL_ID");
        let caller = env_or(
            "CALLER_ADDRESS",
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        );
        let operator_address = env_or(
            "OPERATOR_ADDRESS",
            "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        );
        let private_key = env_or(
            "PRIVATE_KEY",
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        );

        let _ = init_operator_context(TradingOperatorContext {
            operator_address,
            private_key,
            service_id,
            market_data_base_url: String::new(),
            validation_deadline_secs: 300,
            min_validator_score: 0,
            strategy_registry_address: String::new(),
            fee_distributor_address: String::new(),
        });

        let request = TradingProvisionRequest {
            name: env_or("BOT_NAME", "Cloud Aave Yield Bot"),
            strategy_type: env_or("STRATEGY_TYPE", "yield"),
            strategy_config_json: env_or(
                "STRATEGY_CONFIG_JSON",
                r#"{"paper_trade":false,"custom_instructions":"Use Aave on the Ethereum fork. Prefer simple conservative supply/withdraw decisions over leverage. Do not paper trade."}"#,
            ),
            risk_params_json: env_or("RISK_PARAMS_JSON", "{}"),
            factory_address: env_or(
                "VAULT_FACTORY_ADDRESS",
                "0xe70f935c32dA4dB13e7876795f1e175465e6458e",
            )
            .parse::<Address>()
            .expect("VAULT_FACTORY_ADDRESS"),
            asset_token: env_or(
                "ASSET_TOKEN_ADDRESS",
                "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            )
            .parse::<Address>()
            .expect("ASSET_TOKEN_ADDRESS"),
            signers: vec![],
            required_signatures: U256::ZERO,
            chain_id: U256::from(
                env_or("CHAIN_ID", "31338")
                    .parse::<u64>()
                    .expect("CHAIN_ID"),
            ),
            rpc_url: env_or("RPC_URL", "http://127.0.0.1:8545"),
            trading_loop_cron: env_or("TRADING_LOOP_CRON", "0 */5 * * * *"),
            cpu_cores: env_or("CPU_CORES", "1").parse().expect("CPU_CORES"),
            memory_mb: env_or("MEMORY_MB", "2048").parse().expect("MEMORY_MB"),
            max_lifetime_days: env_or("MAX_LIFETIME_DAYS", "30")
                .parse()
                .expect("MAX_LIFETIME_DAYS"),
            validator_service_ids: vec![],
            max_collateral_bps: U256::ZERO,
        };

        let output = provision_core(request, None, call_id, service_id, caller, None)
            .await
            .expect("provision_core");

        println!("{}", serde_json::json!({
            "vault_address": format!("{:#x}", output.vault_address),
            "share_token": format!("{:#x}", output.share_token),
            "sandbox_id": output.sandbox_id,
            "workflow_id": output.workflow_id,
        }));
    });
}
