#!/usr/bin/env bash
# rotate-envelope.sh — operator-driven envelope rotation for the multi-sig
# path.
#
# The single-sig path rotates automatically via the renewal cron in
# trading-http-api/src/envelope_renewal.rs. This script is for the case
# where the cron fires the renewal webhook (because min_signatures > 1 or
# the operator key isn't a signer) and a human signer needs to:
#   1. Pull the staged unsigned envelope from a signing service.
#   2. Sign it locally with their key.
#   3. POST the signature back so the staging service can aggregate quorum.
#
# Once quorum is reached, the staging service issues PUT /envelope to the
# trading API on the operator's behalf — this script does NOT do that.
#
# Usage:
#   rotate-envelope.sh \
#     --bot-id btc-swing-v1 \
#     --signer-key-file ~/.trading/signer1.key \
#     --rpc-url https://mainnet.base.org \
#     --staging-url https://signing.example.com/staged/btc-swing-v1
#
# Options:
#   --bot-id ID            Bot to rotate (required).
#   --signer-key-file F    File containing the signer's hex private key
#                          (required). Mode 0600 is enforced.
#   --staging-url URL      Signing-service URL holding the unsigned envelope
#                          (required).
#   --rpc-url URL          RPC URL for chain-id resolution (required).
#   --auth-token T         Bearer token for the staging service (default:
#                          read from $ROTATE_AUTH_TOKEN).
#   --dry-run              Fetch the unsigned envelope and print the digest
#                          you would sign, but do not POST anything.
#   -h, --help             Show this help and exit.
#
# Required tools: cast, jq, curl.

set -euo pipefail

BOT_ID=""
SIGNER_KEY_FILE=""
STAGING_URL=""
RPC_URL=""
AUTH_TOKEN="${ROTATE_AUTH_TOKEN:-}"
DRY_RUN=0

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-id)         BOT_ID="$2"; shift 2 ;;
    --signer-key-file) SIGNER_KEY_FILE="$2"; shift 2 ;;
    --staging-url)    STAGING_URL="$2"; shift 2 ;;
    --rpc-url)        RPC_URL="$2"; shift 2 ;;
    --auth-token)     AUTH_TOKEN="$2"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    -h|--help)        usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -z "$BOT_ID" || -z "$SIGNER_KEY_FILE" || -z "$STAGING_URL" || -z "$RPC_URL" ]] && {
  echo "ERROR: --bot-id, --signer-key-file, --staging-url, and --rpc-url are required" >&2
  usage 1
}

[[ ! -f "$SIGNER_KEY_FILE" ]] && { echo "ERROR: signer key file not found: $SIGNER_KEY_FILE" >&2; exit 2; }

# Reject world-readable key files.
PERMS="$(stat -c '%a' "$SIGNER_KEY_FILE" 2>/dev/null || stat -f '%A' "$SIGNER_KEY_FILE")"
if [[ "$PERMS" != "600" && "$PERMS" != "400" ]]; then
  echo "ERROR: signer key file must be mode 0600 or 0400 (current: $PERMS)" >&2
  exit 2
fi

for tool in cast jq curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found in PATH" >&2; exit 3; }
done

# ── 1. Fetch unsigned envelope from staging service ──────────────────────
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

UNSIGNED="$TMPDIR/unsigned.json"
echo "fetch: $STAGING_URL"
HEADERS=(-H "Accept: application/json")
[[ -n "$AUTH_TOKEN" ]] && HEADERS+=(-H "Authorization: Bearer $AUTH_TOKEN")
curl -fsS "${HEADERS[@]}" "$STAGING_URL" -o "$UNSIGNED"

if ! jq -e '.digest and .envelope' "$UNSIGNED" >/dev/null; then
  echo "ERROR: staging response is missing .digest or .envelope" >&2
  cat "$UNSIGNED" >&2
  exit 4
fi

DIGEST="$(jq -r '.digest' "$UNSIGNED")"
ENV_NONCE="$(jq -r '.envelope.nonce' "$UNSIGNED")"
ENV_EXPIRES="$(jq -r '.envelope.expiresAt' "$UNSIGNED")"
ENV_BOT_HASH="$(jq -r '.envelope.botIdHash' "$UNSIGNED")"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"

echo
echo "envelope to sign:"
echo "  bot_id:     $BOT_ID"
echo "  bot_hash:   $ENV_BOT_HASH"
echo "  chain_id:   $CHAIN_ID"
echo "  nonce:      $ENV_NONCE"
echo "  expires_at: $ENV_EXPIRES"
echo "  digest:     $DIGEST"
echo

if (( DRY_RUN )); then
  echo "dry run; not signing"
  exit 0
fi

# ── 2. Sign locally with cast ────────────────────────────────────────────
SIGNER_KEY="$(cat "$SIGNER_KEY_FILE")"
SIGNER_ADDR="$(cast wallet address --private-key "$SIGNER_KEY")"
SIGNATURE="$(cast wallet sign --private-key "$SIGNER_KEY" "$DIGEST")"
unset SIGNER_KEY

echo "signed by: $SIGNER_ADDR"
echo "signature: $SIGNATURE"

# ── 3. POST signature back to staging service ────────────────────────────
SIG_PAYLOAD="$(jq -n \
  --arg signer "$SIGNER_ADDR" \
  --arg sig "$SIGNATURE" \
  --arg digest "$DIGEST" \
  '{signer:$signer, signature:$sig, digest:$digest}')"

POST_HEADERS=(-H "Content-Type: application/json" -H "Accept: application/json")
[[ -n "$AUTH_TOKEN" ]] && POST_HEADERS+=(-H "Authorization: Bearer $AUTH_TOKEN")

echo "post:   ${STAGING_URL%/}/signatures"
RESP="$(curl -fsS -X POST "${POST_HEADERS[@]}" \
  -d "$SIG_PAYLOAD" \
  "${STAGING_URL%/}/signatures")"

echo
echo "staging response:"
echo "$RESP" | jq .
echo
echo "rotate-envelope.sh: signature submitted"
