#!/usr/bin/env bash
# wind-down-bot.sh — pause and drain a single trading vault.
#
# Activates wind-down on the vault contract (blocks execute(), enables
# permissionless unwind()) and stops the bot's scheduler in the operator
# process. This is the standard bot-pause primitive — see
# docs/runbook.md §4 and contracts/src/TradingVault.sol::activateWindDown.
#
# Usage:
#   wind-down-bot.sh \
#     --vault 0xVaultAddress \
#     --rpc-url https://mainnet.base.org \
#     --reason "operator-key-rotation"
#
# Options:
#   --vault ADDR           Vault contract address (required).
#   --rpc-url URL          RPC URL (required).
#   --bot-id ID            Bot id for the operator-API stop call. Optional;
#                          omit to skip the off-chain stop.
#   --operator-api URL     Operator API base URL (default:
#                          http://127.0.0.1:9200).
#   --operator-token T     Bearer token for the operator API (default: read
#                          from $OPERATOR_SESSION_TOKEN).
#   --admin-key F          File containing the hex private key of an account
#                          with DEFAULT_ADMIN_ROLE or CREATOR_ROLE on the
#                          vault. Mode 0600 enforced. Required unless
#                          --skip-onchain.
#   --reason TEXT          Free-form reason recorded in stdout/syslog.
#   --skip-onchain         Skip the on-chain activateWindDown(); only stop
#                          the bot in the operator API.
#   --skip-offchain        Skip the operator-API stop; only do on-chain
#                          wind-down.
#   --dry-run              Print the actions; do not call cast / curl.
#   -h, --help             Show this help and exit.
#
# Required tools: cast (when on-chain), curl, jq.

set -euo pipefail

VAULT=""
RPC_URL=""
BOT_ID=""
OPERATOR_API="${OPERATOR_API:-http://127.0.0.1:9200}"
OPERATOR_TOKEN="${OPERATOR_SESSION_TOKEN:-}"
ADMIN_KEY_FILE=""
REASON=""
SKIP_ONCHAIN=0
SKIP_OFFCHAIN=0
DRY_RUN=0

usage() {
  sed -n '2,40p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault)         VAULT="$2"; shift 2 ;;
    --rpc-url)       RPC_URL="$2"; shift 2 ;;
    --bot-id)        BOT_ID="$2"; shift 2 ;;
    --operator-api)  OPERATOR_API="$2"; shift 2 ;;
    --operator-token) OPERATOR_TOKEN="$2"; shift 2 ;;
    --admin-key)     ADMIN_KEY_FILE="$2"; shift 2 ;;
    --reason)        REASON="$2"; shift 2 ;;
    --skip-onchain)  SKIP_ONCHAIN=1; shift ;;
    --skip-offchain) SKIP_OFFCHAIN=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -z "$VAULT" || -z "$RPC_URL" ]] && {
  echo "ERROR: --vault and --rpc-url are required" >&2
  usage 1
}

(( SKIP_ONCHAIN && SKIP_OFFCHAIN )) && {
  echo "ERROR: --skip-onchain and --skip-offchain are mutually exclusive — nothing to do" >&2
  exit 1
}

if (( ! SKIP_ONCHAIN )); then
  [[ -z "$ADMIN_KEY_FILE" ]] && { echo "ERROR: --admin-key required for on-chain wind-down" >&2; usage 1; }
  [[ ! -f "$ADMIN_KEY_FILE" ]] && { echo "ERROR: admin key file not found: $ADMIN_KEY_FILE" >&2; exit 2; }
  PERMS="$(stat -c '%a' "$ADMIN_KEY_FILE" 2>/dev/null || stat -f '%A' "$ADMIN_KEY_FILE")"
  if [[ "$PERMS" != "600" && "$PERMS" != "400" ]]; then
    echo "ERROR: admin key file must be mode 0600 or 0400 (current: $PERMS)" >&2
    exit 2
  fi
  command -v cast >/dev/null 2>&1 || { echo "ERROR: 'cast' not found in PATH" >&2; exit 3; }
fi

if (( ! SKIP_OFFCHAIN )); then
  command -v curl >/dev/null 2>&1 || { echo "ERROR: 'curl' not found in PATH" >&2; exit 3; }
  command -v jq >/dev/null 2>&1 || { echo "ERROR: 'jq' not found in PATH" >&2; exit 3; }
fi

echo "wind-down-bot.sh"
echo "  vault:        $VAULT"
echo "  rpc-url:      $RPC_URL"
echo "  bot-id:       ${BOT_ID:-<none>}"
echo "  reason:       ${REASON:-<unspecified>}"
echo "  skip-onchain: $SKIP_ONCHAIN"
echo "  skip-offchain: $SKIP_OFFCHAIN"
echo "  dry-run:      $DRY_RUN"
echo

# ── 1. On-chain activateWindDown ─────────────────────────────────────────
if (( ! SKIP_ONCHAIN )); then
  CURRENT_STATE="$(cast call "$VAULT" 'windDownActive()(bool)' --rpc-url "$RPC_URL" 2>/dev/null || echo "unknown")"
  echo "current windDownActive=$CURRENT_STATE"

  if [[ "$CURRENT_STATE" == "true" ]]; then
    echo "vault already in wind-down; skipping activateWindDown()"
  else
    if (( DRY_RUN )); then
      echo "DRY: cast send $VAULT 'activateWindDown()' --rpc-url $RPC_URL --private-key <admin>"
    else
      ADMIN_KEY="$(cat "$ADMIN_KEY_FILE")"
      cast send "$VAULT" 'activateWindDown()' \
        --rpc-url "$RPC_URL" \
        --private-key "$ADMIN_KEY"
      unset ADMIN_KEY
      echo "activateWindDown() submitted"
    fi
  fi
fi

# ── 2. Off-chain stop via operator API ───────────────────────────────────
if (( ! SKIP_OFFCHAIN )) && [[ -n "$BOT_ID" ]]; then
  [[ -z "$OPERATOR_TOKEN" ]] && {
    echo "WARN: --operator-token / OPERATOR_SESSION_TOKEN not set; skipping off-chain stop" >&2
  } || {
    URL="${OPERATOR_API%/}/api/bots/${BOT_ID}/stop"
    if (( DRY_RUN )); then
      echo "DRY: curl -X POST $URL"
    else
      RESP="$(curl -fsS -X POST \
        -H "Authorization: Bearer $OPERATOR_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"reason\":\"$(printf '%s' "$REASON" | jq -Rs . | sed -e 's/^"//' -e 's/"$//')\"}" \
        "$URL")"
      echo "operator API response:"
      echo "$RESP" | jq . 2>/dev/null || echo "$RESP"
    fi
  }
fi

echo
echo "wind-down-bot.sh: done"
