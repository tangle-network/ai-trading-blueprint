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

// One exec reads all three artifacts and prints a single JSON object. Strategy
// sources are head-capped so a large workspace can't blow the exec response.
// metrics_latest is parsed when valid JSON, else passed through as the raw
// string (never throws). Missing files become null / {}.
//
// Fed to node via a quoted heredoc on stdin (`node - <<'NODE'`) — the same form
// the live tick verifier uses (jobs/workflow_tick.rs). The sidecar's terminal
// endpoint runs `command` raw (no shell wrapping), so a bare `node -e '…'` with
// inner quotes is mangled to an empty program (exit 0, empty stdout → a 502
// "EOF while parsing"). The heredoc carries the script on stdin, immune to that.
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
process.stdout.write(JSON.stringify({
  decisions_jsonl: r('/home/agent/logs/decisions.jsonl'),
  metrics_latest: mp,
  strategies: strat,
}));
NODE"#;

/// Read `{ decisions_jsonl, metrics_latest, strategies }` from the bot's
/// sandbox. Returns an error string on missing sandbox / exec failure / unparsable
/// output — callers fail closed (no fabricated "captured" flag).
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
    let stdout = resp.stdout.trim();
    serde_json::from_str(stdout).map_err(|e| {
        format!(
            "tick-artifacts JSON parse failed: {e} (stdout={:?}, stderr={:?})",
            stdout.chars().take(200).collect::<String>(),
            resp.stderr.trim().chars().take(200).collect::<String>(),
        )
    })
}
