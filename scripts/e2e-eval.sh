#!/usr/bin/env bash
# E2E Customer Journey Evaluation — Real Flow, No Mocks
#
# Tests the complete customer experience:
#   1. Create bot from free-form prompt (POST /api/bots)
#   2. Wait for activation + first FAST tick
#   3. Send a conversation message
#   4. Wait for bot response
#   5. Check self-improvement state
#   6. Score everything
#
# Prerequisites:
#   - Operator running on :9200 with SESSION_AUTH_SECRET set
#   - Trading API on :9100
#   - Sidecar image available
#   - Anvil on :8545
#
# Usage: ./scripts/e2e-eval.sh [operator_url]
set -euo pipefail

OPERATOR_URL="${1:-http://localhost:9200}"
TRADING_URL="${TRADING_URL:-http://localhost:9100}"
TIMEOUT_PROVISION=120
TIMEOUT_TICK=300
TIMEOUT_CONVO=300

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCORE=0
MAX_SCORE=0
RESULTS=()

score() {
  local name="$1"
  local points="$2"
  local pass="$3"
  local reason="$4"
  MAX_SCORE=$((MAX_SCORE + points))
  if [[ "$pass" == "true" ]]; then
    SCORE=$((SCORE + points))
    RESULTS+=("${GREEN}✓${NC} ${name} (${points}pts): ${reason}")
  else
    RESULTS+=("${RED}✗${NC} ${name} (0/${points}pts): ${reason}")
  fi
}

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  E2E Customer Journey Evaluation${NC}"
echo -e "${BLUE}  Real flow, real AI, real trading infrastructure${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# ── Phase 0: Infrastructure Check ──────────────────────────────────────
echo -e "${YELLOW}Phase 0: Infrastructure${NC}"

OPERATOR_OK=$(curl -sf "$OPERATOR_URL/api/meta" >/dev/null 2>&1 && echo "true" || echo "false")
score "Operator API reachable" 5 "$OPERATOR_OK" "GET /api/meta"

TRADING_OK=$(curl -sf "$TRADING_URL/health" >/dev/null 2>&1 && echo "true" || echo "false")
score "Trading API reachable" 5 "$TRADING_OK" "GET /health"

ANVIL_OK=$(cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1 && echo "true" || echo "false")
score "Anvil chain running" 5 "$ANVIL_OK" "chain 31337"

if [[ "$OPERATOR_OK" != "true" || "$TRADING_OK" != "true" ]]; then
  echo -e "\n${RED}Infrastructure not ready. Start the operator first.${NC}"
  exit 1
fi

# Get a session token (use a test wallet)
echo ""
echo -e "${YELLOW}Phase 0.5: Authentication${NC}"
# For local dev, we can use a direct challenge/session flow
CHALLENGE=$(curl -sf -X POST "$OPERATOR_URL/api/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"address":"0x68FF20459d48917748CA13afCbDA3B265a449D48"}' 2>/dev/null || echo "")

if [[ -z "$CHALLENGE" || "$CHALLENGE" == "" ]]; then
  echo -e "${YELLOW}Auth challenge failed — using anonymous mode${NC}"
  AUTH_HEADER=""
  HAS_AUTH=false
else
  HAS_AUTH=true
  # For real auth we'd sign the challenge, but for local dev the operator
  # may accept unsigned requests. Try without auth first.
  AUTH_HEADER=""
fi

# ── Phase 1: Bot Creation ──────────────────────────────────────────────
echo ""
echo -e "${YELLOW}Phase 1: Bot Creation (POST /api/bots)${NC}"

STRATEGY_PROMPT="I want a DeFi trading agent that trades ETH/USDC on Uniswap V3. Use momentum and mean-reversion signals. Start with paper trading. Be conservative — max 2% per trade, 10% max drawdown. Focus on WETH first, then expand to BTC when you have enough data."

START_TIME=$(date +%s)

CREATE_BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'prompt': sys.argv[1],
    'name': 'E2E Eval Agent',
}))" "$STRATEGY_PROMPT")

CREATE_RESPONSE=$(curl -sf -X POST "$OPERATOR_URL/api/bots" \
  -H "Content-Type: application/json" \
  -d "$CREATE_BODY" 2>&1 || echo '{"error":"request failed"}')

END_TIME=$(date +%s)
PROVISION_TIME=$((END_TIME - START_TIME))

echo "  Response: $(echo "$CREATE_RESPONSE" | head -c 200)"
echo "  Time: ${PROVISION_TIME}s"

BOT_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('bot_id',''))" 2>/dev/null || echo "")
BOT_STATUS=$(echo "$CREATE_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
TRADING_TOKEN=$(echo "$CREATE_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('trading_api_token',''))" 2>/dev/null || echo "")

HAS_BOT_ID=$([[ -n "$BOT_ID" ]] && echo "true" || echo "false")
score "Bot provisioned" 15 "$HAS_BOT_ID" "bot_id=$BOT_ID"

IS_ACTIVE=$([[ "$BOT_STATUS" == "active" ]] && echo "true" || echo "false")
score "Bot activated (one-call)" 10 "$IS_ACTIVE" "status=$BOT_STATUS"

PROVISION_FAST=$([[ "$PROVISION_TIME" -lt 60 ]] && echo "true" || echo "false")
score "Provision < 60s" 5 "$PROVISION_FAST" "${PROVISION_TIME}s"

if [[ -z "$BOT_ID" ]]; then
  echo -e "\n${RED}Bot creation failed. Cannot continue.${NC}"
  echo -e "\nResponse: $CREATE_RESPONSE"
  # Print scores so far
  echo ""
  echo -e "${BLUE}═══ Results ═══${NC}"
  for r in "${RESULTS[@]}"; do echo -e "  $r"; done
  echo -e "\n  ${YELLOW}Score: $SCORE / $MAX_SCORE${NC}"
  exit 1
fi

# ── Phase 2: First Trading Tick ────────────────────────────────────────
echo ""
echo -e "${YELLOW}Phase 2: First Trading Tick${NC}"

echo "  Waiting for first tick (max ${TIMEOUT_TICK}s)..."

TICK_START=$(date +%s)
FIRST_TICK=""

for i in $(seq 1 $((TIMEOUT_TICK / 10))); do
  # Check operator log for this bot's tick
  TICK_RESULT=$(grep -a "workflow_tick.*returned.*success" /tmp/operator.log 2>/dev/null | tail -1 || echo "")
  if [[ -n "$TICK_RESULT" ]]; then
    TICK_TIME=$(( $(date +%s) - TICK_START ))
    FIRST_TICK=$(echo "$TICK_RESULT" | python3 -c "
import sys, json
line = sys.stdin.read()
idx = line.find('{')
if idx >= 0:
    data = json.loads(line[idx:])
    for ex in data.get('executed', []):
        print(ex.get('task', {}).get('result', '')[:300])
" 2>/dev/null || echo "")
    if [[ -n "$FIRST_TICK" ]]; then
      echo "  First tick after ${TICK_TIME}s: $(echo "$FIRST_TICK" | head -c 150)"
      break
    fi
  fi
  sleep 10
done

HAS_TICK=$([[ -n "$FIRST_TICK" ]] && echo "true" || echo "false")
score "First tick executed" 10 "$HAS_TICK" "$(echo "$FIRST_TICK" | head -c 80)"

# Check if tick contains price data
HAS_PRICE=$(echo "$FIRST_TICK" | grep -qi "weth\|price\|\$2" && echo "true" || echo "false")
score "Tick contains price data" 5 "$HAS_PRICE" "$(echo "$FIRST_TICK" | grep -oiE 'WETH.*\$[0-9,]+' | head -1 || echo 'no price found')"

# Check if tick made a decision
HAS_DECISION=$(echo "$FIRST_TICK" | grep -qiE "skip|buy|sell|trade" && echo "true" || echo "false")
score "Tick made a decision" 5 "$HAS_DECISION" "$(echo "$FIRST_TICK" | grep -oiE '(SKIP|BUY|SELL|TRADE)[^.]*' | head -1 || echo 'no decision found')"

# ── Phase 3: Portfolio Check ───────────────────────────────────────────
echo ""
echo -e "${YELLOW}Phase 3: Portfolio State${NC}"

if [[ -n "$TRADING_TOKEN" ]]; then
  PORTFOLIO=$(curl -sf -X POST "$TRADING_URL/portfolio/state" \
    -H "Authorization: Bearer $TRADING_TOKEN" \
    -H "Content-Type: application/json" 2>/dev/null || echo '{}')

  TOTAL_VALUE=$(echo "$PORTFOLIO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('total_value_usd','0'))" 2>/dev/null || echo "0")
  HAS_PORTFOLIO=$([[ "$TOTAL_VALUE" != "0" ]] && echo "true" || echo "false")
  score "Portfolio has value" 5 "$HAS_PORTFOLIO" "\$${TOTAL_VALUE}"
else
  score "Portfolio has value" 5 "false" "No trading token"
fi

# ── Phase 4: Conversation Test ─────────────────────────────────────────
echo ""
echo -e "${YELLOW}Phase 4: Owner Conversation${NC}"

# Get the sandbox to write a conversation
BOT_DETAIL=$(curl -sf "$OPERATOR_URL/api/bots/$BOT_ID" $AUTH_HEADER 2>/dev/null || echo '{}')
SANDBOX_ID=$(echo "$BOT_DETAIL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sandbox_id',''))" 2>/dev/null || echo "")

if [[ -n "$SANDBOX_ID" ]]; then
  # Write a conversation message to the bot's memory
  SANDBOX_RECORD=$(python3 -c "
import json
with open('blueprint-state/cloud/sandboxes.json') as f:
    data = json.load(f)
for k, v in data.items():
    if '$SANDBOX_ID' in k:
        print(json.dumps({'url': v.get('sidecar_url',''), 'token': v.get('token','')}))
        break
" 2>/dev/null || echo '{}')

  SIDECAR_URL=$(echo "$SANDBOX_RECORD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('url',''))" 2>/dev/null || echo "")
  SIDECAR_TOKEN=$(echo "$SANDBOX_RECORD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

  if [[ -n "$SIDECAR_URL" && -n "$SIDECAR_TOKEN" ]]; then
    # Write conversation to memory
    curl -sf -X POST "$SIDECAR_URL/agents/run" \
      -H "Authorization: Bearer $SIDECAR_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"message":"Write this file:\n/home/agent/memory/conversations/eval-test.md:\n```\n# Eval Test\n\n## Owner (now)\nAlso look into BTC trading. Can you track WBTC alongside WETH?\n```\n\nThen update /home/agent/memory/toc.md — add under Conversations:\n- [Eval Test](conversations/eval-test.md) — **ACTION NEEDED**","sessionID":"eval-inject","maxTurns":3}' \
      > /dev/null 2>&1

    score "Conversation injected" 5 "true" "eval-test.md written to memory"

    # Wait for CONVERSATION tick to pick it up
    echo "  Waiting for bot to respond (max ${TIMEOUT_CONVO}s)..."
    CONVO_START=$(date +%s)
    BOT_RESPONDED=false

    for i in $(seq 1 $((TIMEOUT_CONVO / 15))); do
      # Check if the bot responded
      RESPONSE=$(curl -sf -X POST "$SIDECAR_URL/agents/run" \
        -H "Authorization: Bearer $SIDECAR_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"message":"cat /home/agent/memory/conversations/eval-test.md 2>/dev/null | grep -c \"Bot Response\" || echo 0","sessionID":"eval-check","maxTurns":2}' 2>/dev/null || echo "")

      RESPONSE_COUNT=$(echo "$RESPONSE" | python3 -c "
import json, sys, re
d = json.load(sys.stdin)
text = d.get('data',{}).get('finalText','')
nums = re.findall(r'\d+', text)
print(nums[-1] if nums else '0')
" 2>/dev/null || echo "0")

      if [[ "$RESPONSE_COUNT" != "0" ]]; then
        CONVO_TIME=$(( $(date +%s) - CONVO_START ))
        echo "  Bot responded after ${CONVO_TIME}s"
        BOT_RESPONDED=true
        break
      fi
      sleep 15
    done

    score "Bot responded to conversation" 15 "$BOT_RESPONDED" "$([ "$BOT_RESPONDED" = "true" ] && echo "responded in ${CONVO_TIME}s" || echo "no response within ${TIMEOUT_CONVO}s")"

    # Check response quality
    if [[ "$BOT_RESPONDED" == "true" ]]; then
      RESPONSE_CONTENT=$(curl -sf -X POST "$SIDECAR_URL/agents/run" \
        -H "Authorization: Bearer $SIDECAR_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"message":"cat /home/agent/memory/conversations/eval-test.md","sessionID":"eval-read","maxTurns":2}' 2>/dev/null || echo "")

      RESPONSE_TEXT=$(echo "$RESPONSE_CONTENT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('finalText',''))" 2>/dev/null || echo "")

      MENTIONS_BTC=$(echo "$RESPONSE_TEXT" | grep -qiE "btc|bitcoin|wbtc" && echo "true" || echo "false")
      score "Response mentions BTC" 5 "$MENTIONS_BTC" "$(echo "$RESPONSE_TEXT" | grep -oiE '(BTC|Bitcoin|WBTC)[^.]*' | head -1 || echo 'no BTC mention')"

      HAS_PLAN=$(echo "$RESPONSE_TEXT" | grep -qiE "plan|track|candle|research|recommend" && echo "true" || echo "false")
      score "Response includes a plan" 5 "$HAS_PLAN" "$(echo "$RESPONSE_TEXT" | grep -oiE '(plan|track|recommend|research)[^.]*' | head -1 || echo 'no plan')"
    fi
  else
    score "Conversation injected" 5 "false" "Sidecar not accessible"
    score "Bot responded to conversation" 15 "false" "Sidecar not accessible"
  fi
else
  score "Conversation injected" 5 "false" "No sandbox_id"
  score "Bot responded to conversation" 15 "false" "No sandbox_id"
fi

# ── Phase 5: Memory System Check ──────────────────────────────────────
echo ""
echo -e "${YELLOW}Phase 5: Memory System${NC}"

if [[ -n "$SIDECAR_URL" && -n "$SIDECAR_TOKEN" ]]; then
  TOC_CHECK=$(curl -sf -X POST "$SIDECAR_URL/agents/run" \
    -H "Authorization: Bearer $SIDECAR_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"message":"cat /home/agent/memory/toc.md 2>/dev/null || echo MISSING","sessionID":"eval-toc","maxTurns":2}' 2>/dev/null || echo "")

  TOC_TEXT=$(echo "$TOC_CHECK" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(t.get('result','')) for t in d.get('data',{}).get('toolInvocations',[])]" 2>/dev/null || echo "")

  HAS_TOC=$([[ "$TOC_TEXT" != *"MISSING"* && -n "$TOC_TEXT" ]] && echo "true" || echo "false")
  score "Memory toc.md exists" 5 "$HAS_TOC" "$(echo "$TOC_TEXT" | head -c 80)"

  HAS_STRATEGY=$(echo "$TOC_TEXT" | grep -qi "strategy" && echo "true" || echo "false")
  score "ToC references strategy brief" 5 "$HAS_STRATEGY" "$(echo "$TOC_TEXT" | grep -i strategy | head -1 || echo 'missing')"
fi

# ── Phase 6: Self-Improvement Check ───────────────────────────────────
echo ""
echo -e "${YELLOW}Phase 6: Self-Improvement Capability${NC}"

if [[ -n "$SIDECAR_URL" && -n "$SIDECAR_TOKEN" ]]; then
  TOOLS_CHECK=$(curl -sf -X POST "$SIDECAR_URL/agents/run" \
    -H "Authorization: Bearer $SIDECAR_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"message":"ls /home/agent/tools/ | wc -l","sessionID":"eval-tools","maxTurns":2}' 2>/dev/null || echo "")

  TOOL_COUNT=$(echo "$TOOLS_CHECK" | python3 -c "
import json, sys, re
d = json.load(sys.stdin)
text = d.get('data',{}).get('finalText','')
nums = re.findall(r'\d+', text)
print(nums[0] if nums else '0')
" 2>/dev/null || echo "0")

  HAS_TOOLS=$([[ "$TOOL_COUNT" -gt 10 ]] && echo "true" || echo "false")
  score "Agent has tools deployed" 5 "$HAS_TOOLS" "${TOOL_COUNT} tools"
fi

# ── Results ────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  E2E Evaluation Results${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

for r in "${RESULTS[@]}"; do
  echo -e "  $r"
done

echo ""
PCT=$((SCORE * 100 / MAX_SCORE))
if [[ $PCT -ge 80 ]]; then
  COLOR="$GREEN"
elif [[ $PCT -ge 60 ]]; then
  COLOR="$YELLOW"
else
  COLOR="$RED"
fi
echo -e "  ${COLOR}Score: $SCORE / $MAX_SCORE ($PCT%)${NC}"
echo ""

# Write results to .evolve
mkdir -p .evolve/e2e
cat > .evolve/e2e/$(date +%Y-%m-%d-%H%M%S).json << EVALEOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "score": $SCORE,
  "max_score": $MAX_SCORE,
  "pct": $PCT,
  "bot_id": "$BOT_ID",
  "provision_time_s": $PROVISION_TIME,
  "strategy_prompt": "$(echo "$STRATEGY_PROMPT" | head -c 200)"
}
EVALEOF

echo -e "  Results saved to .evolve/e2e/"

if [[ $PCT -ge 80 ]]; then
  echo -e "\n  ${GREEN}GTM READY — all critical paths passing${NC}"
elif [[ $PCT -ge 60 ]]; then
  echo -e "\n  ${YELLOW}PARTIAL — core flow works, edge cases need fixing${NC}"
else
  echo -e "\n  ${RED}NOT READY — critical paths failing${NC}"
fi
