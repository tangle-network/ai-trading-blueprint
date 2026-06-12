use serde_json::{Map, Value};

pub fn operator_ai_env() -> Result<Map<String, Value>, String> {
    let mut env = Map::new();
    let providers: &[(&str, &str, &str, &[&str])] = &[
        (
            "ANTHROPIC_API_KEY",
            "anthropic",
            "claude-sonnet-4-6",
            &["ANTHROPIC_API_KEY"],
        ),
        (
            "ZAI_API_KEY",
            "zai-coding-plan",
            "glm-4.7",
            &["ZAI_API_KEY"],
        ),
        (
            "TANGLE_API_KEY",
            "openrouter",
            "anthropic/claude-sonnet-4-6",
            &["TANGLE_API_KEY", "TANGLE_ROUTER_API_KEY"],
        ),
        (
            "TANGLE_ROUTER_API_KEY",
            "openrouter",
            "anthropic/claude-sonnet-4-6",
            &["TANGLE_ROUTER_API_KEY", "TANGLE_API_KEY"],
        ),
    ];

    for &(env_var, model_provider, model_name, native_keys) in providers {
        let Ok(key) = std::env::var(env_var) else {
            continue;
        };
        if key.trim().is_empty() {
            continue;
        }
        env.insert("OPENCODE_MODEL_PROVIDER".into(), model_provider.into());
        env.insert("OPENCODE_MODEL_NAME".into(), model_name.into());
        env.insert("OPENCODE_MODEL_API_KEY".into(), key.clone().into());
        // Every provider must also publish an OpenAI-compatible base URL:
        // the in-sandbox trace analysts call it directly via fetch, and
        // without it they skip with no-model-env (proven live on the fleet —
        // the ZAI path shipped without a base URL and no analyst ever ran).
        if env_var == "TANGLE_API_KEY" || env_var == "TANGLE_ROUTER_API_KEY" {
            let base_url = std::env::var("TANGLE_ROUTER_BASE_URL")
                .unwrap_or_else(|_| "https://router.tangle.tools/v1".to_string());
            env.insert("TANGLE_ROUTER_BASE_URL".into(), base_url.clone().into());
            env.insert("OPENCODE_MODEL_BASE_URL".into(), base_url.into());
        } else if env_var == "ZAI_API_KEY" {
            env.insert(
                "OPENCODE_MODEL_BASE_URL".into(),
                "https://api.z.ai/api/coding/paas/v4".into(),
            );
        } else if env_var == "ANTHROPIC_API_KEY" {
            // Anthropic's OpenAI-compat surface; opencode itself uses the
            // native protocol, the analysts use this.
            env.insert(
                "OPENCODE_MODEL_BASE_URL".into(),
                "https://api.anthropic.com/v1".into(),
            );
        }
        for native_key in native_keys {
            env.insert((*native_key).into(), key.clone().into());
        }
        return Ok(env);
    }

    Err(
        "No API keys provided and operator has no pre-configured AI keys. \
         Set ANTHROPIC_API_KEY, ZAI_API_KEY, or TANGLE_API_KEY in the operator environment."
            .to_string(),
    )
}
