#!/usr/bin/env bash
# Live Polymarket price-history eval.
#
# Fetches an active market from Gamma, pulls CLOB price history, converts it
# into candles, and runs the real trading-runtime walk-forward backtester.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(node -e 'process.stdout.write(new Date().toISOString().replace(/[:.]/g, "-"))')"
OUT="${1:-"$ROOT/.evolve/evals/real-polymarket-price-history-$STAMP.json"}"

cd "$ROOT"
cargo run -p trading-runtime --example polymarket_real_price_eval -- --out "$OUT"
