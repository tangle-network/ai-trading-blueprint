// Slice A (F2+F3): decision-provenance hashing.
//
// Proves the canonical `recipe_hash` / `input_hash` contract end-to-end against
// the REAL tick JS tools by running them in a real Node process and writing to
// a real file. No logic is mocked; only the hardcoded sandbox output path
// (`/home/agent/logs/decisions.jsonl`) is redirected to a temp dir, exactly as
// the sandbox deploy redirects it via `activate.rs`.
//
// Regressions this catches:
//   (a) recipe_hash/input_hash stop being deterministic (same recipe+inputs
//       must produce byte-identical hashes — the attestation guarantee).
//   (b) reordering recipe/input keys changes the hash (stableStringify broken).
//   (c) changing any recipe param does NOT change recipe_hash (hash ignores
//       input it should cover).
//   (d) recipe_hash/input_hash absent from a written decisions.jsonl line.

use std::path::PathBuf;
use std::process::Command;

fn tool_src(name: &str) -> &'static str {
    match name {
        "log_decision.js" => include_str!("../src/prompts/tools/log_decision.js"),
        _ => panic!("unknown tool {name}"),
    }
}

/// Run a Node script that requires the real log_decision.js module (with its
/// output path redirected into `tmp`) and print one JSON line of results.
fn run_node(tmp: &std::path::Path, script: &str) -> serde_json::Value {
    // Materialize the real module, redirecting only the hardcoded LOG_FILE path.
    let module_src = tool_src("log_decision.js").replace(
        "'/home/agent/logs/decisions.jsonl'",
        &format!("{:?}", tmp.join("decisions.jsonl").to_string_lossy()),
    );
    let module_path = tmp.join("log_decision.js");
    std::fs::write(&module_path, module_src).unwrap();

    let script_path = tmp.join("run.js");
    let full = format!(
        "const m = require({:?});\n{script}",
        module_path.to_string_lossy()
    );
    std::fs::write(&script_path, full).unwrap();

    let out = Command::new("node")
        .arg(&script_path)
        .output()
        .expect("node must be installed");
    assert!(
        out.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let last = stdout
        .trim()
        .lines()
        .last()
        .expect("node produced no output");
    serde_json::from_str(last).unwrap_or_else(|e| panic!("bad json {last:?}: {e}"))
}

fn unique_tmp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tnt-prov-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn provenance_hash_is_deterministic_and_order_independent() {
    let tmp = unique_tmp("det");
    // recipe encoded with two different key orderings + a numerically-equal but
    // re-ordered nested object must hash identically; input likewise.
    let res = run_node(
        &tmp,
        r#"
        const recipeA = { family: 'mm', harness: { mm: { target_base_weight: 0.5, rebalance_band_pct: 0.1 }, min_order_usd: 10 } };
        const recipeB = { harness: { min_order_usd: 10, mm: { rebalance_band_pct: 0.1, target_base_weight: 0.5 } }, family: 'mm' };
        const inputA = { checked_state: { base_weight: 0.6, inventory_usd: 100, weth_price: 2000 }, intent: null };
        const inputB = { intent: null, checked_state: { weth_price: 2000, inventory_usd: 100, base_weight: 0.6 } };
        console.log(JSON.stringify({
          recipe_a: m.provenanceHash(recipeA),
          recipe_b: m.provenanceHash(recipeB),
          input_a: m.provenanceHash(inputA),
          input_b: m.provenanceHash(inputB),
          stable_a: m.stableStringify(recipeA),
          stable_b: m.stableStringify(recipeB),
        }));
        "#,
    );
    assert_eq!(
        res["recipe_a"], res["recipe_b"],
        "identical recipe with reordered keys must hash identically"
    );
    assert_eq!(
        res["input_a"], res["input_b"],
        "identical inputs with reordered keys must hash identically"
    );
    assert_eq!(
        res["stable_a"], res["stable_b"],
        "stableStringify must be order-independent"
    );
    // sha256 hex is 64 chars.
    assert_eq!(res["recipe_a"].as_str().unwrap().len(), 64);
}

#[test]
fn changing_a_recipe_param_changes_recipe_hash() {
    let tmp = unique_tmp("param");
    let res = run_node(
        &tmp,
        r#"
        const base = { family: 'mm', harness: { mm: { target_base_weight: 0.5 }, min_order_usd: 10 } };
        const changedParam = { family: 'mm', harness: { mm: { target_base_weight: 0.55 }, min_order_usd: 10 } };
        const sameInput = { checked_state: { base_weight: 0.6 }, intent: null };
        console.log(JSON.stringify({
          base_recipe: m.provenanceHash(base),
          changed_recipe: m.provenanceHash(changedParam),
          // input unchanged -> input_hash must NOT move when only recipe moves
          input_unchanged_a: m.provenanceHash(sameInput),
          input_unchanged_b: m.provenanceHash(sameInput),
        }));
        "#,
    );
    assert_ne!(
        res["base_recipe"], res["changed_recipe"],
        "changing target_base_weight must change recipe_hash"
    );
    assert_eq!(
        res["input_unchanged_a"], res["input_unchanged_b"],
        "input_hash must be stable when inputs are unchanged"
    );
}

#[test]
fn written_decision_line_carries_recipe_and_input_hash() {
    let tmp = unique_tmp("write");
    // Replicate exactly what tick_common.js runTick lines 380-381 do: compute
    // both hashes via the canonical helper and stamp them into the logged entry.
    let res = run_node(
        &tmp,
        r#"
        const family = 'mm';
        const harness = { mm: { target_base_weight: 0.5, rebalance_band_pct: 0.1 }, min_order_usd: 10 };
        const strategy_config = { protocol: 'aerodrome', protocol_chain_id: 8453 };
        const checkedState = { base_weight: 0.62, inventory_usd: 100, weth_price: 2000 };
        const decision = { action: 'trade', reason: 'mm-rebalance-sell-base', intent: { token_in: 'weth', token_out: 'usdc' } };

        const recipe_hash = m.provenanceHash({ family, harness, strategy_config });
        const input_hash = m.provenanceHash({ family, checked_state: checkedState, intent: decision.intent });

        const entry = m.logDecision({ ...decision, state: checkedState, run_started_at: '2026-05-30T00:00:00.000Z', recipe_hash, input_hash });
        console.log(JSON.stringify({ entry, recipe_hash, input_hash }));
        "#,
    );

    // (d) the in-memory entry carries both hashes.
    assert_eq!(res["entry"]["recipe_hash"], res["recipe_hash"]);
    assert_eq!(res["entry"]["input_hash"], res["input_hash"]);
    assert!(res["entry"]["timestamp"].is_string());

    // The real file on disk carries them too (full write-path proof).
    let line = std::fs::read_to_string(tmp.join("decisions.jsonl")).unwrap();
    let logged: serde_json::Value =
        serde_json::from_str(line.trim().lines().last().unwrap()).unwrap();
    assert_eq!(logged["recipe_hash"], res["recipe_hash"]);
    assert_eq!(logged["input_hash"], res["input_hash"]);
    assert_eq!(logged["action"], "trade");
    assert_eq!(logged["reason"], "mm-rebalance-sell-base");

    // Re-running the same recipe+inputs is byte-identical in the hashes
    // (the attestation guarantee).
    let tmp2 = unique_tmp("write2");
    let res2 = run_node(
        &tmp2,
        r#"
        const family = 'mm';
        const harness = { mm: { target_base_weight: 0.5, rebalance_band_pct: 0.1 }, min_order_usd: 10 };
        const strategy_config = { protocol: 'aerodrome', protocol_chain_id: 8453 };
        const checkedState = { base_weight: 0.62, inventory_usd: 100, weth_price: 2000 };
        const decision = { action: 'trade', reason: 'mm-rebalance-sell-base', intent: { token_in: 'weth', token_out: 'usdc' } };
        const recipe_hash = m.provenanceHash({ family, harness, strategy_config });
        const input_hash = m.provenanceHash({ family, checked_state: checkedState, intent: decision.intent });
        console.log(JSON.stringify({ recipe_hash, input_hash }));
        "#,
    );
    assert_eq!(
        res["recipe_hash"], res2["recipe_hash"],
        "unchanged recipe must re-hash byte-identically across runs"
    );
    assert_eq!(
        res["input_hash"], res2["input_hash"],
        "unchanged inputs must re-hash byte-identically across runs"
    );
}
