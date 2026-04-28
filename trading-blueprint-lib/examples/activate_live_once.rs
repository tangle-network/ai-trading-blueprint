use std::env;

use serde_json::{Map, Value};
use trading_blueprint_lib::jobs::activate_bot_with_secrets;

fn env_or(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_string())
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    runtime.block_on(async move {
        let bot_id = env::var("BOT_ID").expect("BOT_ID");
        let mut user_env = Map::<String, Value>::new();

        if let Some(key) = optional_env("ZAI_API_KEY") {
            user_env.insert("ZAI_API_KEY".to_string(), Value::String(key.clone()));
            user_env.insert("OPENCODE_MODEL_API_KEY".to_string(), Value::String(key));
        }

        user_env.insert(
            "OPENCODE_MODEL_PROVIDER".to_string(),
            Value::String(env_or("OPENCODE_MODEL_PROVIDER", "zai-coding-plan")),
        );
        user_env.insert(
            "OPENCODE_MODEL_NAME".to_string(),
            Value::String(env_or("OPENCODE_MODEL_NAME", "glm-4.7")),
        );
        user_env.insert(
            "USER_STRATEGY_PROMPT".to_string(),
            Value::String(env_or(
                "USER_STRATEGY_PROMPT",
                "Use Aave on the Ethereum fork. Prefer simple conservative supply/withdraw decisions over leverage. Do not paper trade.",
            )),
        );

        let output = activate_bot_with_secrets(&bot_id, user_env, None)
            .await
            .expect("activate_bot_with_secrets");

        println!(
            "{}",
            serde_json::json!({
                "sandbox_id": output.sandbox_id,
                "workflow_id": output.workflow_id,
            })
        );
    });
}
