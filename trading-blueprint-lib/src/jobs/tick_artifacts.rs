//! Read a bot's deterministic-tick side effects out of its sandbox.
//!
//! The fast tick writes `decisions.jsonl` + `metrics/latest.json` (and the bot
//! may write strategy files) INSIDE the sandbox. The eval, running outside,
//! cannot see them — so it could never tell a real tick decision from a
//! fabricated prose claim (the RLM analyst's `tick.side_effects_captured`
//! signal). This exposes those artifacts over one sidecar exec so the operator
//! API can hand them to the eval (and the box exposes the same path live).

use ai_agent_sandbox_blueprint_lib::{SandboxExecRequest, run_exec_request};
use serde_json::Value;

use crate::state::TradingBotRecord;

// Sentinel markers framing the JSON payload in stdout. The sidecar's terminal
// endpoint ECHOES the typed command into stdout ahead of the program's real
// output, so stdout is `<echoed script>\n<actual output>` — parsing the whole
// thing as JSON fails on the echoed source. We extract only the bytes between
// these markers. Crucially the markers are CONCATENATED at runtime in the
// script (`'TANGLE' + '_TICK_JSON>'`), so the echoed *source* never contains
// the joined literal — only the program's actual output does. Keep these in
// sync with the `'…' + '…'` split in READ_TICK_ARTIFACTS_JS below.
const TICK_JSON_BEGIN: &str = "TANGLE_TICK_JSON>";
const TICK_JSON_END: &str = "<TANGLE_TICK_END";

// One exec reads all runtime artifacts and prints a single JSON object framed by
// the sentinels above. Strategy sources are head-capped so a large workspace
// can't blow the exec response. metrics_latest is parsed when valid JSON, else
// passed through as the raw string (never throws). Missing files become null/{}.
// coverage_jsonl carries the structured insufficient-coverage findings (G4) the
// eval reads to tell a deliberate skip from a sparse-data blind spot.
//
// Fed to node via a quoted heredoc on stdin (`node - <<'NODE'`) — the same form
// the live tick verifier uses (jobs/workflow_tick.rs). A bare `node -e '…'` with
// inner quotes is unreliable through the sidecar PTY; the heredoc carries the
// script on stdin.
const READ_TICK_ARTIFACTS_JS: &str = r#"node - <<'NODE'
const fs = require('fs');
const r = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
let strat = {};
try {
  const d = '/home/agent/tools/strategies';
  for (const f of fs.readdirSync(d)) {
    if (f.endsWith('.js')) { try { strat[f] = fs.readFileSync(d + '/' + f, 'utf8').slice(0, 8000); } catch {} }
  }
} catch {}
let m = r('/home/agent/metrics/latest.json');
let mp = null;
try { mp = m ? JSON.parse(m) : null; } catch { mp = m; }
const payload = JSON.stringify({
  decisions_jsonl: r('/home/agent/logs/decisions.jsonl'),
  decision_contexts_jsonl: r('/home/agent/memory/decision-contexts.jsonl'),
  reflections_jsonl: r('/home/agent/memory/reflections.jsonl'),
  improvement_intents_jsonl: r('/home/agent/memory/improvement-intents.jsonl'),
  improvement_dispatches_jsonl: r('/home/agent/memory/improvement-dispatches.jsonl'),
  coverage_jsonl: r('/home/agent/logs/tick_coverage.jsonl'),
  metrics_latest: mp,
  strategies: strat,
});
const B = 'TANGLE' + '_TICK_JSON>';
const E = '<TANGLE' + '_TICK_END';
process.stdout.write('\n' + B + payload + E + '\n');
NODE"#;

/// Read the bot's runtime evidence from its sandbox. Returns an error string on
/// missing sandbox / exec failure / unparsable output — callers fail closed (no
/// fabricated "captured" flag).
#[tracing::instrument(name = "read_tick_artifacts", skip_all, fields(bot_id = %bot.id))]
pub async fn read_bot_tick_artifacts(bot: &TradingBotRecord) -> Result<Value, String> {
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|e| format!("sandbox lookup failed: {e}"))?;
    let exec = SandboxExecRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        command: READ_TICK_ARTIFACTS_JS.to_string(),
        cwd: String::new(),
        env_json: "{}".to_string(),
        timeout_ms: 15_000,
    };
    let resp = run_exec_request(&exec, &sandbox.token)
        .await
        .map_err(|e| format!("tick-artifacts exec failed: {e}"))?;
    if resp.exit_code != 0 {
        return Err(format!(
            "tick-artifacts read exited {}: {}",
            resp.exit_code,
            resp.stderr.trim()
        ));
    }
    // Extract the JSON framed by the sentinels (stdout also carries the PTY's
    // echo of the typed command — see the marker comment above).
    let json = resp
        .stdout
        .split_once(TICK_JSON_BEGIN)
        .and_then(|(_, rest)| rest.split_once(TICK_JSON_END))
        .map(|(payload, _)| payload);
    let Some(payload) = json else {
        return Err(format!(
            "tick-artifacts markers not found (stdout={:?}, stderr={:?})",
            resp.stdout.chars().take(300).collect::<String>(),
            resp.stderr.trim().chars().take(200).collect::<String>(),
        ));
    };
    serde_json::from_str(payload).map_err(|e| {
        format!(
            "tick-artifacts JSON parse failed: {e} (payload={:?})",
            payload.chars().take(300).collect::<String>(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression: the sandbox reader must collect the coverage JSONL so the eval
    // can distinguish a deliberate skip from a sparse-data blind spot (G4). If a
    // refactor drops the coverage read, this catches it before it ships.
    #[test]
    fn reader_script_collects_coverage_jsonl() {
        assert!(
            READ_TICK_ARTIFACTS_JS
                .contains("coverage_jsonl: r('/home/agent/logs/tick_coverage.jsonl')"),
            "tick-artifacts reader must read /home/agent/logs/tick_coverage.jsonl into coverage_jsonl"
        );
        assert!(
            READ_TICK_ARTIFACTS_JS
                .contains("decision_contexts_jsonl: r('/home/agent/memory/decision-contexts.jsonl')"),
            "tick-artifacts reader must expose runtime DecisionContext records"
        );
        assert!(
            READ_TICK_ARTIFACTS_JS
                .contains("reflections_jsonl: r('/home/agent/memory/reflections.jsonl')"),
            "tick-artifacts reader must expose runtime ReflectionRecord records"
        );
    }

    // The payload shape the eval consumes must expose coverage_jsonl alongside
    // decisions_jsonl. This parses a representative reader payload and asserts the
    // coverage findings round-trip as queryable JSON, not an opaque blob.
    #[test]
    fn coverage_payload_exposes_structured_findings() {
        let coverage_line = r#"{"timestamp":"2026-05-30T14:23:45.456Z","family":"mm","finding":"insufficient_coverage","have":12,"need":30,"metric":"candles"}"#;
        let payload = serde_json::json!({
            "decisions_jsonl": "{\"action\":\"skip\"}\n",
            "decision_contexts_jsonl": "{\"context_id\":\"ctx_1\"}\n",
            "reflections_jsonl": "{\"reflection_id\":\"refl_1\",\"decision_context_id\":\"ctx_1\"}\n",
            "improvement_intents_jsonl": "{\"intent_id\":\"intent_1\"}\n",
            "improvement_dispatches_jsonl": null,
            "coverage_jsonl": format!("{coverage_line}\n"),
            "metrics_latest": null,
            "strategies": {},
        });

        let coverage_raw = payload
            .get("coverage_jsonl")
            .and_then(Value::as_str)
            .expect("coverage_jsonl present");
        let first = coverage_raw.lines().next().expect("one coverage line");
        let finding: Value = serde_json::from_str(first).expect("coverage line is JSON");
        assert_eq!(finding["finding"], "insufficient_coverage");
        assert_eq!(finding["have"], 12);
        assert_eq!(finding["need"], 30);
        assert_eq!(finding["metric"], "candles");
    }
}
