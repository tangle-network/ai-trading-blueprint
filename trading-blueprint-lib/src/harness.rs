//! Per-bot agent harness selection.
//!
//! The sidecar server (pinned `blueprint-sidecar-base` layer) selects its
//! provider adapter from two seams, in priority order:
//!
//! 1. `backend.type` in the `POST /agents/run` body
//!    (`createBootstrapConfig`: `overrides.backend?.type ?? backendEnv.defaultBackend`),
//! 2. the `AGENT_BACKEND` container env var, parsed by
//!    `loadBackendEnvironmentConfig` with fallback `"opencode"`.
//!
//! We plumb both: `AGENT_BACKEND` is injected at activation so cron workflow
//! ticks (which cannot set `backend.type` — the sandbox-blueprint payload
//! builder only carries `backend.profile`) inherit the harness, and the
//! operator-chat path sets `backend.type` explicitly.
//!
//! The supported set is the intersection of three constraints, derived from the
//! deployed artifacts (do not widen it without re-verifying all three):
//! - adapter registered in the sidecar server bundle (`registerAdapterFactory`
//!   in the pinned base image: opencode, claude-code, codex, kimi-code, amp,
//!   factory-droids, pi, hermes, openclaw, forge, acp, cursor),
//! - CLI binary present in this repo's `blueprint-sidecar:all-harness` image
//!   (`nix/agent-clis.nix`: opencode, claude, codex, qwen, gemini, amp, pi,
//!   forgecode, factory-droids, codex-acp, copilot),
//! - an auth path the operator environment can actually satisfy
//!   (`operator_credentials::harness_ai_env`).
//!
//! Known-but-rejected harnesses get a precise reason so config-time errors are
//! actionable instead of a bare "unsupported".

use serde_json::{Map, Value};

/// Default harness — the only one the blueprint drove before per-bot selection.
pub const DEFAULT_AGENT_HARNESS: &str = "opencode";

/// Harnesses that are driveable end-to-end through the deployed sidecar today.
pub const SUPPORTED_AGENT_HARNESSES: &[&str] = &["opencode", "claude-code", "codex"];

/// Why a harness the sidecar knows about is still not selectable here.
/// Keyed by the sidecar's backend-type string (and common aliases).
const REJECTED_HARNESS_REASONS: &[(&str, &str)] = &[
    (
        "kimi-code",
        "the `kimi` CLI binary is not in the blueprint-sidecar:all-harness image",
    ),
    (
        "amp",
        "requires a Sourcegraph AMP_API_KEY the operator environment does not provision",
    ),
    (
        "factory-droids",
        "requires a FACTORY_API_KEY the operator environment does not provision",
    ),
    (
        "pi",
        "pi resolves credentials per model provider at run time; no validated operator auth path",
    ),
    (
        "forge",
        "the image ships the binary as `forgecode` but the sidecar adapter spawns `forge`",
    ),
    (
        "hermes",
        "the `hermes` CLI binary is not in the blueprint-sidecar:all-harness image",
    ),
    (
        "openclaw",
        "the `openclaw` CLI binary is not in the blueprint-sidecar:all-harness image",
    ),
    (
        "acp",
        "requires a config.subAgent the blueprint does not plumb",
    ),
    (
        "cursor",
        "requires a CURSOR_API_KEY the operator environment does not provision",
    ),
    (
        "gemini",
        "no provider adapter is registered for gemini in the sidecar server",
    ),
    (
        "qwen",
        "no provider adapter is registered for qwen in the sidecar server",
    ),
    (
        "github-copilot",
        "no provider adapter is registered for github-copilot in the sidecar server",
    ),
];

/// Normalize and validate a user-supplied harness identifier.
///
/// Accepts the sidecar backend-type strings plus obvious aliases. Rejects
/// anything outside [`SUPPORTED_AGENT_HARNESSES`] with a reason when the
/// harness is known, so misconfiguration fails at config time, not run time
/// (an invalid `AGENT_BACKEND` would otherwise be silently coerced back to
/// opencode by the sidecar's `parseBackendTypeFromEnv`).
pub fn normalize_agent_harness(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_ascii_lowercase();
    let canonical = match normalized.as_str() {
        "claude" | "claude_code" => "claude-code".to_string(),
        "kimi" | "kimi_code" => "kimi-code".to_string(),
        "factory_droids" | "droid" | "droids" => "factory-droids".to_string(),
        other => other.to_string(),
    };

    if SUPPORTED_AGENT_HARNESSES.contains(&canonical.as_str()) {
        return Ok(canonical);
    }

    let supported = SUPPORTED_AGENT_HARNESSES.join(", ");
    if let Some((_, reason)) = REJECTED_HARNESS_REASONS
        .iter()
        .find(|(name, _)| *name == canonical)
    {
        return Err(format!(
            "agent_harness '{raw}' is not supported: {reason}. Supported harnesses: {supported}"
        ));
    }
    Err(format!(
        "agent_harness '{raw}' is not a known sidecar backend. Supported harnesses: {supported}"
    ))
}

/// Read the per-bot harness from a parsed `strategy_config` object.
/// Absent or empty → [`DEFAULT_AGENT_HARNESS`]; present → validated.
pub fn agent_harness_from_strategy_config(
    strategy_config: Option<&Map<String, Value>>,
) -> Result<String, String> {
    let Some(obj) = strategy_config else {
        return Ok(DEFAULT_AGENT_HARNESS.to_string());
    };
    match obj.get("agent_harness") {
        None | Some(Value::Null) => Ok(DEFAULT_AGENT_HARNESS.to_string()),
        Some(Value::String(raw)) if raw.trim().is_empty() => Ok(DEFAULT_AGENT_HARNESS.to_string()),
        Some(Value::String(raw)) => normalize_agent_harness(raw),
        Some(other) => Err(format!(
            "strategy_config_json.agent_harness must be a string (got {other})"
        )),
    }
}

/// Convenience wrapper for the bot record's `strategy_config` value.
/// Any malformed stored value degrades to the default rather than wedging
/// chat/tick paths — validation happens at provision/configure time.
pub fn agent_harness_for_bot(strategy_config: &Value) -> String {
    agent_harness_from_strategy_config(strategy_config.as_object())
        .unwrap_or_else(|_| DEFAULT_AGENT_HARNESS.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_when_absent() {
        assert_eq!(
            agent_harness_from_strategy_config(None).unwrap(),
            "opencode"
        );
        let empty = Map::new();
        assert_eq!(
            agent_harness_from_strategy_config(Some(&empty)).unwrap(),
            "opencode"
        );
    }

    #[test]
    fn accepts_supported_and_aliases() {
        assert_eq!(normalize_agent_harness("OpenCode").unwrap(), "opencode");
        assert_eq!(normalize_agent_harness("claude").unwrap(), "claude-code");
        assert_eq!(
            normalize_agent_harness(" claude-code ").unwrap(),
            "claude-code"
        );
        assert_eq!(normalize_agent_harness("codex").unwrap(), "codex");
    }

    #[test]
    fn rejects_known_but_undriveable_with_reason() {
        let err = normalize_agent_harness("gemini").unwrap_err();
        assert!(err.contains("no provider adapter"), "{err}");
        let err = normalize_agent_harness("amp").unwrap_err();
        assert!(err.contains("AMP_API_KEY"), "{err}");
        let err = normalize_agent_harness("forge").unwrap_err();
        assert!(err.contains("forgecode"), "{err}");
    }

    #[test]
    fn rejects_unknown() {
        let err = normalize_agent_harness("totally-made-up").unwrap_err();
        assert!(err.contains("not a known sidecar backend"), "{err}");
    }

    #[test]
    fn rejects_non_string() {
        let config = json!({ "agent_harness": 42 });
        let err = agent_harness_from_strategy_config(config.as_object()).unwrap_err();
        assert!(err.contains("must be a string"), "{err}");
    }

    #[test]
    fn bot_value_degrades_to_default() {
        assert_eq!(agent_harness_for_bot(&Value::Null), "opencode");
        assert_eq!(
            agent_harness_for_bot(&json!({ "agent_harness": "nonsense" })),
            "opencode"
        );
        assert_eq!(
            agent_harness_for_bot(&json!({ "agent_harness": "codex" })),
            "codex"
        );
    }
}
