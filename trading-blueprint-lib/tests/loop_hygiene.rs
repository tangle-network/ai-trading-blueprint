// Loop hygiene regression tests against the REAL sandbox tools, run in a real
// Node process (same pattern as decision_provenance.rs). No logic is mocked;
// only the hardcoded /home/agent paths are redirected via the tools' own env
// overrides (AGENT_ROOT / AGENT_WORKSPACE).
//
// Regressions these catch (2026-06-12 live-box audit):
//   (a) improvement-intent spam: a breaker-halted bot accumulated 22 pending
//       intents with the IDENTICAL cooldown_key — the key was computed but
//       never enforced.
//   (b) reflection spam: 200/200 consecutive reflections on a frozen bot were
//       byte-identical halt-and-investigate records, feeding candidate
//       generation downstream.
//   (c) continuous-float mutations: every candidate_hash unique (RSI 30 →
//       24.286512076854702), so the 7-day auto-generation dedupe NEVER fired
//       (385 candidates / 0 dedups in 17h).

use std::process::Command;

fn run_node(dir: &std::path::Path, program: &str, envs: &[(&str, String)]) -> serde_json::Value {
    let script_path = dir.join("driver-script");
    std::fs::write(&script_path, program).unwrap();
    let mut cmd = Command::new("node");
    cmd.arg(&script_path);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let out = cmd.output().expect("node must be installed");
    assert!(
        out.status.success(),
        "node failed: {}\n{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let last = stdout
        .trim()
        .lines()
        .last()
        .expect("node produced no output");
    serde_json::from_str(last).unwrap_or_else(|e| panic!("bad json {last:?}: {e}"))
}

#[test]
fn reflection_repeats_are_suppressed_and_intents_deduped_per_cooldown_key() {
    let tmp = tempfile::tempdir().unwrap();
    let module_path = tmp.path().join("reflection-loop.js");
    std::fs::write(
        &module_path,
        include_str!("../src/prompts/tools/reflection_loop.js"),
    )
    .unwrap();

    // Each context produces the same high-severity findings (no observations +
    // blocked action path) => same reflection signature and same cooldown_key.
    let driver = r#"
const fs = require('fs');
const loop = require(process.env.LOOP_MODULE);
const baseContext = (id, extra = {}) => ({
  context_id: id,
  family: 'dex',
  mandate: { bot_id: 'bot-hygiene-1' },
  decision: { action: 'skip', reason: 'validation-rejected: insufficient quote coverage' },
  evidence: {},
  ...extra,
});
const lines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
};
const readState = () => JSON.parse(fs.readFileSync(loop.REFLECTION_STATE_FILE, 'utf8'));

const r1 = loop.reflectOnDecisionContext(baseContext('ctx-1'));
const r2 = loop.reflectOnDecisionContext(baseContext('ctx-2'));
const startedBeforeR3 = Date.now();
const r3 = loop.reflectOnDecisionContext(baseContext('ctx-3'));
const stateAfterR3 = readState();
// Changed signature (one finding resolved) but identical cooldown_key.
const r4 = loop.reflectOnDecisionContext(baseContext('ctx-4', { evidence: { observed_prior_actions: true } }));

console.log(JSON.stringify({
  r1: { repeat: !!r1.repeat_suppressed, intent: r1.emitted_improvement_intent_id || null, id: r1.reflection_id },
  r2: { repeat: !!r2.repeat_suppressed, repeat_count: r2.repeat_count, repeat_of: r2.repeat_of_reflection_id },
  r3: { repeat: !!r3.repeat_suppressed, repeat_count: r3.repeat_count },
  r4: { repeat: !!r4.repeat_suppressed, intent: r4.emitted_improvement_intent_id || null },
  reflections: lines(loop.REFLECTIONS_FILE).map((r) => r.type || 'full'),
  intents: lines(loop.IMPROVEMENT_INTENTS_FILE).map((i) => ({ key: i.cooldown_key, status: i.status })),
  dedupe: JSON.parse(fs.readFileSync(loop.INTENT_DEDUPE_FILE, 'utf8')),
  state_after_r3: {
    context: stateAfterR3.last_decision_context_id,
    fresh: Date.parse(stateAfterR3.updated_at) >= startedBeforeR3,
  },
  state_final: readState(),
}));
"#;

    let result = run_node(
        tmp.path(),
        driver,
        &[
            ("AGENT_ROOT", tmp.path().to_string_lossy().to_string()),
            ("LOOP_MODULE", module_path.to_string_lossy().to_string()),
        ],
    );

    // First reflection is full and emits exactly one improvement intent.
    assert_eq!(result["r1"]["repeat"], false, "{result}");
    assert!(result["r1"]["intent"].is_string(), "{result}");

    // Identical signatures are suppressed with a running repeat counter; the
    // first repeat writes one compact marker, later ones within the hour none.
    assert_eq!(result["r2"]["repeat"], true, "{result}");
    assert_eq!(result["r2"]["repeat_count"], 1, "{result}");
    assert_eq!(result["r2"]["repeat_of"], result["r1"]["id"], "{result}");
    assert_eq!(result["r3"]["repeat"], true, "{result}");
    assert_eq!(result["r3"]["repeat_count"], 2, "{result}");

    // A changed signature always writes a full reflection again.
    assert_eq!(result["r4"]["repeat"], false, "{result}");
    assert_eq!(
        result["reflections"],
        serde_json::json!(["full", "reflection-repeat", "full"]),
        "1 full + 1 hourly marker + 1 full on signature change: {result}"
    );

    // One pending intent per cooldown_key: r4's identical key is suppressed
    // and counted in the dedupe state instead of growing the queue.
    let intents = result["intents"].as_array().unwrap();
    assert_eq!(
        intents.len(),
        1,
        "duplicate cooldown_key appended: {result}"
    );
    assert!(result["r4"]["intent"].is_null(), "{result}");
    let key = intents[0]["key"].as_str().unwrap();
    assert_eq!(result["dedupe"][key]["repeat_count"], 1, "{result}");

    // On a fully-suppressed tick (r3) the verifier's evidence is the state
    // file: it must be freshly stamped and tied to that tick's context.
    assert_eq!(result["state_after_r3"]["context"], "ctx-3", "{result}");
    assert_eq!(result["state_after_r3"]["fresh"], true, "{result}");
    assert_eq!(result["state_final"]["repeat_count"], 0, "{result}");
}

#[test]
fn candidate_mutations_are_quantized_so_hash_dedupe_can_fire() {
    let tmp = tempfile::tempdir().unwrap();
    // The orchestrator is type-annotation-free TS; materialize it as ESM and
    // import the real mutator. Its CJS sibling tools are materialized too.
    std::fs::write(
        tmp.path().join("self-improvement-loop.mjs"),
        include_str!("../src/prompts/tools/self_improvement_loop.ts"),
    )
    .unwrap();
    for (name, content) in [
        (
            "api_client.js",
            include_str!("../src/prompts/tools/api_client.js"),
        ),
        (
            "usage_telemetry.js",
            include_str!("../src/prompts/tools/usage_telemetry.js"),
        ),
        (
            "observatory_pressure.js",
            include_str!("../src/prompts/tools/observatory_pressure.js"),
        ),
    ] {
        std::fs::write(tmp.path().join(name), content).unwrap();
    }

    let driver = r#"
import { mutateHarness, quantize } from './self-improvement-loop.mjs';
const baseline = {
  version: 1,
  entry_rules: [
    { signal: { type: 'rsi', period: 5 }, condition: { type: 'below', threshold: 40.0 }, weight: 1.0, tokens: [] },
    { signal: { type: 'ema_cross', short_period: 9, long_period: 21 }, condition: { type: 'above', threshold: 70.0 }, weight: 0.5, tokens: [] },
  ],
  exit_rules: [{ type: 'take_profit', pct: 10.0 }, { type: 'stop_loss', pct: 8.0 }],
  filters: [],
  position_sizing: { method: 'fixed_fraction', fraction: 0.3 },
  entry_threshold: 0.3,
  max_positions: 3,
};
// Clamp bounds may sit off-grid (e.g. fraction floor 0.02); boundary values
// still dedupe (a single repeated value), so they pass the grid check.
function onGrid(v, step, lo, hi) {
  if (v === lo || v === hi) return true;
  const q = v / step;
  return Math.abs(q - Math.round(q)) < 1e-6;
}
const failures = [];
for (let seed = 0; seed < 500; seed++) {
  for (const intent of ['', 'be more conservative about drawdown', 'aggressive higher return']) {
    const child = mutateHarness(baseline, seed, intent);
    if (JSON.stringify(child) !== JSON.stringify(mutateHarness(baseline, seed, intent))) {
      failures.push(`seed ${seed}: non-deterministic`);
    }
    if (!onGrid(child.entry_threshold, 0.05, 0.05, 0.95)) failures.push(`seed ${seed}: entry_threshold ${child.entry_threshold}`);
    if (!onGrid(child.position_sizing.fraction, 0.05, 0.02, 0.4)) failures.push(`seed ${seed}: fraction ${child.position_sizing.fraction}`);
    if (!Number.isInteger(child.max_positions)) failures.push(`seed ${seed}: max_positions ${child.max_positions}`);
    for (const rule of child.entry_rules) {
      if (rule.weight !== undefined && !onGrid(rule.weight, 0.05, 0.05, 1.0)) failures.push(`seed ${seed}: weight ${rule.weight}`);
      if (rule.signal?.type === 'rsi') {
        if (!Number.isInteger(rule.signal.period)) failures.push(`seed ${seed}: rsi period ${rule.signal.period}`);
        if (!onGrid(rule.condition.threshold, 1, 5, 95)) failures.push(`seed ${seed}: rsi threshold ${rule.condition.threshold}`);
      }
      if (rule.signal?.type === 'ema_cross'
        && (!Number.isInteger(rule.signal.short_period) || !Number.isInteger(rule.signal.long_period))) {
        failures.push(`seed ${seed}: ema periods`);
      }
    }
    for (const exit of child.exit_rules) {
      const [lo, hi] = exit.type === 'stop_loss' ? [1, 15] : [2, 30];
      if (!onGrid(exit.pct, 0.5, lo, hi)) failures.push(`seed ${seed}: ${exit.type} ${exit.pct}`);
    }
  }
}
console.log(JSON.stringify({
  quantize_int: quantize(24.286512076854702, 1),
  quantize_half: quantize(7.3712, 0.5),
  quantize_fraction: quantize(0.1234, 0.05),
  failure_count: failures.length,
  failures: failures.slice(0, 10),
}));
"#;
    let driver_path = tmp.path().join("driver.mjs");
    std::fs::write(&driver_path, driver).unwrap();

    let out = Command::new("node")
        .arg(&driver_path)
        .env("AGENT_WORKSPACE", tmp.path())
        .output()
        .expect("node must be installed");
    assert!(
        out.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let result: serde_json::Value =
        serde_json::from_str(stdout.trim().lines().last().unwrap()).unwrap();

    assert_eq!(result["quantize_int"], 24, "{result}");
    assert_eq!(result["quantize_half"], 7.5, "{result}");
    assert_eq!(result["quantize_fraction"], 0.1, "{result}");
    assert_eq!(
        result["failure_count"], 0,
        "off-grid mutated values: {result}"
    );
}
