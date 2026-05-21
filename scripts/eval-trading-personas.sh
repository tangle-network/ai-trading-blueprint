#!/usr/bin/env bash
# Real trading-agent persona eval.
#
# Runs deterministic adversarial market scenarios through trading-runtime's
# backtest engine and writes a machine-readable report for agent-eval analyst
# loops and release gates.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +"%Y-%m-%dT%H-%M-%S-%3NZ")"
OUT="${1:-"$ROOT/.evolve/evals/trading-agent-personas-$STAMP.json"}"

cd "$ROOT"
cargo run -p trading-runtime --example agent_persona_eval -- --out "$OUT"
