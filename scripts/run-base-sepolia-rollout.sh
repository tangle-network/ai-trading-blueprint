#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TMP_DIR="$ROOT_DIR/.tmp"
RUNTIME_DIR="$TMP_DIR/base-sepolia-run"
OPERATOR_LOG="$TMP_DIR/base-sepolia-operator.log"
PRICING_LOG="$TMP_DIR/base-sepolia-pricing.log"
CREATE_JSON="$TMP_DIR/base-sepolia-create.json"
RUN_JSON="$TMP_DIR/base-sepolia-run-now.json"
SETTINGS_FILE="${SETTINGS_FILE:-$ROOT_DIR/settings.env}"

cd "$ROOT_DIR"
if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "ERROR: settings file not found: $SETTINGS_FILE" >&2
  echo "Create a local settings.env from settings.env.example before running this rollout." >&2
  exit 1
fi

set -a
source "$SETTINGS_FILE"
set +a

mkdir -p "$TMP_DIR"
bash "$SCRIPT_DIR/reset-local-state.sh"

cleanup() {
  if [[ -n "${OPERATOR_PID:-}" ]]; then
    kill "$OPERATOR_PID" 2>/dev/null || true
  fi
  if [[ -n "${PRICING_PID:-}" ]]; then
    kill "$PRICING_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Starting pricing engine..."
PRICING_ENGINE_BIN="$ROOT_DIR/../blueprint/target/debug/pricing-engine-server" \
  bash "$SCRIPT_DIR/run-pricing-engine.sh" --config "$SCRIPT_DIR/operator1.toml" \
  >"$PRICING_LOG" 2>&1 &
PRICING_PID=$!

echo "Starting operator..."
../blueprint/target/debug/cargo-tangle blueprint run \
  --protocol tangle \
  --network testnet \
  --http-rpc-url "$HTTP_RPC_URL" \
  --ws-rpc-url "$WS_RPC_URL" \
  --keystore-path /tmp/tangle-base-sepolia-keystore \
  --data-dir "$RUNTIME_DIR" \
  --settings-file "$SETTINGS_FILE" \
  >"$OPERATOR_LOG" 2>&1 &
OPERATOR_PID=$!

wait_for_url() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 60); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "$label is healthy"
      return 0
    fi
    sleep 1
  done
  echo "$label failed to become healthy"
  return 1
}

wait_for_url "http://127.0.0.1:9200/api/meta" "operator"
wait_for_url "http://127.0.0.1:9100/health" "trading API"

challenge="$(curl -sf -X POST http://127.0.0.1:9200/api/auth/challenge)"
nonce="$(printf '%s' "$challenge" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).nonce))')"
message="$(printf '%s' "$challenge" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).message))')"
signature="$(cast wallet sign --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 "$message" | tr -d '\n')"
session_token="$(
  curl -sf -X POST http://127.0.0.1:9200/api/auth/session \
    -H 'Content-Type: application/json' \
    --data "{\"nonce\":\"$nonce\",\"signature\":\"$signature\"}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
)"

create_body='{"prompt":"Create a conservative Base Sepolia paper-trading bot for ETH/USDC on Uniswap V3. Use momentum plus mean reversion signals. Max 2% per trade, max 10% drawdown, paper trade only.","name":"Base Sepolia Rollout Plan"}'
curl -sf -X POST http://127.0.0.1:9200/api/bots \
  -H "Authorization: Bearer $session_token" \
  -H 'Content-Type: application/json' \
  --data "$create_body" >"$CREATE_JSON"

bot_id="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.bot_id)' "$CREATE_JSON")"
sandbox_id="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.sandbox_id)' "$CREATE_JSON")"
trading_token="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.trading_api_token)' "$CREATE_JSON")"
sidecar_name="sidecar-$sandbox_id"

for _ in $(seq 1 60); do
  if docker ps --format '{{.Names}}' | grep -qx "$sidecar_name"; then
    break
  fi
  sleep 1
done

docker exec "$sidecar_name" sh -lc 'cat > /AGENTS.md <<'"'"'EOF'"'"'
# Sidecar Workspace

This sandbox is pre-seeded for the trading agent runtime.
Use /home/agent as the writable workspace root.
EOF'

curl -sf -X POST "http://127.0.0.1:9200/api/bots/$bot_id/run-now" \
  -H "Authorization: Bearer $session_token" >"$RUN_JSON"

workflow_id="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.workflow_id)' "$RUN_JSON")"

for _ in $(seq 1 180); do
  if [[ -f "$ROOT_DIR/blueprint-state/workflow-runtime.json" ]]; then
    if node -e '
      const fs=require("fs");
      const path=process.argv[1];
      const workflowId=process.argv[2];
      const data=JSON.parse(fs.readFileSync(path,"utf8"));
      const entry=data[workflowId];
      process.exit(entry && entry.latestExecution ? 0 : 1);
    ' "$ROOT_DIR/blueprint-state/workflow-runtime.json" "$workflow_id"; then
      break
    fi
  fi
  sleep 1
done

echo "CREATE"
cat "$CREATE_JSON"
echo
echo "RUN"
cat "$RUN_JSON"
echo
echo "RUNTIME"
cat "$ROOT_DIR/blueprint-state/workflow-runtime.json"
echo
echo "WORKFLOWS"
cat "$ROOT_DIR/blueprint-state/workflows.json"
echo
echo "PORTFOLIO"
curl -s -X POST http://127.0.0.1:9100/portfolio/state \
  -H "Authorization: Bearer $trading_token" \
  -H 'Content-Type: application/json'
echo
echo "SIDECAR ERRORS"
docker logs --since 5m "$sidecar_name" 2>&1 | rg -n 'EACCES: permission denied, mkdir .*/\.sidecar/state|ENOENT: no such file or directory, open .*/AGENTS.md|AGENT_EXECUTION_FAILED|already running|Health check threshold exceeded' || true
echo "SIDECAR SUCCESSES"
docker logs --since 5m "$sidecar_name" 2>&1 | rg -n 'Trade executed|No messages\.|Prompt and event processing completed|runAgent COMPLETED|Released session|Execution result:' || true
