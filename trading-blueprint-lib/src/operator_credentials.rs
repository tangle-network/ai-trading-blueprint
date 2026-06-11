use serde_json::{Map, Value};

fn env_string(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn tangle_router_base_url() -> String {
    std::env::var("TANGLE_ROUTER_BASE_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://router.tangle.tools/v1".to_string())
}

/// Sidecar env additions for a non-default agent harness.
///
/// Env var names come from the sidecar server's `CLI_AGENT_SPECS`
/// (pinned bundle): `AGENT_BACKEND` selects the default backend type for every
/// run (chat + cron workflow ticks); per-CLI auth/model vars are read by
/// `loadBackendEnvironmentConfig` and passed to the adapter's `buildExecEnv`.
///
/// Fails when the operator environment cannot authenticate the harness, so a
/// bad `agent_harness` choice surfaces at provision/configure/activate time
/// with an actionable message instead of an in-sandbox spawn failure.
pub fn harness_ai_env(harness: &str) -> Result<Map<String, Value>, String> {
    let mut env = Map::new();
    match harness {
        // opencode is configured by operator_ai_env() (OPENCODE_MODEL_*);
        // AGENT_BACKEND is omitted because opencode is the sidecar default.
        crate::harness::DEFAULT_AGENT_HARNESS => return Ok(env),
        "claude-code" => {
            // The claude CLI speaks the Anthropic Messages protocol —
            // ANTHROPIC_BASE_URL cannot point at an OpenAI-compatible router,
            // so the Tangle router key is NOT an accepted fallback here.
            let key = env_string(&["ANTHROPIC_API_KEY"]).ok_or_else(|| {
                "agent_harness 'claude-code' requires ANTHROPIC_API_KEY in the operator environment"
                    .to_string()
            })?;
            env.insert("ANTHROPIC_API_KEY".into(), key.into());
            if let Some(base_url) = env_string(&["ANTHROPIC_BASE_URL"]) {
                env.insert("ANTHROPIC_BASE_URL".into(), base_url.into());
            }
            if let Some(model) = env_string(&["CLAUDE_CODE_MODEL_NAME", "ANTHROPIC_MODEL"]) {
                env.insert("CLAUDE_CODE_MODEL_NAME".into(), model.into());
            }
        }
        "codex" => {
            // The codex CLI honours OPENAI_BASE_URL, so the OpenAI-compatible
            // Tangle router is a first-class auth path alongside a native key.
            if let Some(key) = env_string(&["OPENAI_API_KEY"]) {
                env.insert("OPENAI_API_KEY".into(), key.into());
                if let Some(base_url) = env_string(&["OPENAI_BASE_URL"]) {
                    env.insert("OPENAI_BASE_URL".into(), base_url.into());
                }
            } else if let Some(key) = env_string(&["TANGLE_API_KEY", "TANGLE_ROUTER_API_KEY"]) {
                env.insert("OPENAI_API_KEY".into(), key.into());
                env.insert("OPENAI_BASE_URL".into(), tangle_router_base_url().into());
            } else {
                return Err(
                    "agent_harness 'codex' requires OPENAI_API_KEY or TANGLE_API_KEY in the operator environment"
                        .to_string(),
                );
            }
            if let Some(model) = env_string(&["CODEX_MODEL_NAME", "TANGLE_ROUTER_MODEL"]) {
                env.insert("CODEX_MODEL_NAME".into(), model.into());
            }
        }
        other => {
            // Defensive: callers validate via harness::normalize_agent_harness
            // first; keep this fail-closed for any future drift.
            return Err(format!(
                "agent_harness '{other}' has no operator credential mapping"
            ));
        }
    }
    env.insert("AGENT_BACKEND".into(), harness.into());
    Ok(env)
}

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
        if env_var == "TANGLE_API_KEY" || env_var == "TANGLE_ROUTER_API_KEY" {
            let base_url = std::env::var("TANGLE_ROUTER_BASE_URL")
                .unwrap_or_else(|_| "https://router.tangle.tools/v1".to_string());
            env.insert("TANGLE_ROUTER_BASE_URL".into(), base_url.clone().into());
            env.insert("OPENCODE_MODEL_BASE_URL".into(), base_url.into());
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
