#!/usr/bin/env bash
# restore-state.sh — pull a state snapshot from S3 and atomic-swap into
# the operator state directory.
#
# Use after a disk-loss event (see docs/disaster-recovery.md §3.2). Pulls
# envelopes, learning state, and registry into a staging dir, then renames
# the staging dir into <state_dir> in a single mv. If any download fails
# the in-place state dir is NOT touched.
#
# Usage:
#   restore-state.sh \
#     --state-dir /var/lib/trading-blueprint/state \
#     --s3-uri s3://my-bucket/ \
#     --hostname host-01 \
#     --as-of latest
#
# Options:
#   --state-dir DIR      Destination state directory (required).
#   --s3-uri URI         S3 bucket URI (required).
#   --hostname HOST      Hostname segment in S3 path (required).
#   --as-of SUFFIX       Snapshot suffix to restore. 'latest' = pick the most
#                        recent under each kind/<host>/ prefix. Otherwise an
#                        explicit YYYYMMDDTHHMMSSZ value (required).
#   --bot-id ID          Restore only one bot's state (envelope + learning).
#                        Useful for the per-bot LearningStoreCorruption flow.
#   --kind KIND          Restore only one kind: envelopes | learning | registry.
#                        Repeatable; defaults to all three.
#   --dry-run            Print what would be downloaded without doing it.
#   -h, --help           Show this help and exit.
#
# Required tools: aws-cli, jq.

set -euo pipefail

STATE_DIR=""
S3_URI=""
HOSTNAME_VAL=""
AS_OF=""
BOT_ID=""
KINDS=()
DRY_RUN=0

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --s3-uri)    S3_URI="$2"; shift 2 ;;
    --hostname)  HOSTNAME_VAL="$2"; shift 2 ;;
    --as-of)     AS_OF="$2"; shift 2 ;;
    --bot-id)    BOT_ID="$2"; shift 2 ;;
    --kind)      KINDS+=("$2"); shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -z "$STATE_DIR" || -z "$S3_URI" || -z "$HOSTNAME_VAL" || -z "$AS_OF" ]] && {
  echo "ERROR: --state-dir, --s3-uri, --hostname, and --as-of are required" >&2
  usage 1
}

if [[ ${#KINDS[@]} -eq 0 ]]; then
  KINDS=(trading-envelopes learning registry)
fi

for tool in aws jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found in PATH" >&2; exit 3; }
done

S3_URI="${S3_URI%/}/"

# ── resolve 'latest' suffix ──────────────────────────────────────────────
resolve_latest() {
  local kind="$1"
  aws s3 ls "${S3_URI}${kind}/${HOSTNAME_VAL}/" \
    | awk '/PRE/ {print $2}' \
    | tr -d '/' \
    | sort \
    | tail -n1
}

# ── per-kind restore ─────────────────────────────────────────────────────
STAGING="${STATE_DIR}.restore.$$"
mkdir -p "$STAGING"
trap 'rm -rf "$STAGING"' EXIT

restore_kind() {
  local kind="$1"
  local suffix="$2"
  local src="${S3_URI}${kind}/${HOSTNAME_VAL}/${suffix}/"
  local dst="${STAGING}/${kind}"

  mkdir -p "$dst"

  if [[ -n "$BOT_ID" && "$kind" != "registry" ]]; then
    # Per-bot restore: only that bot's JSON file (envelopes/<bot>.json or
    # learning/<bot>.json).
    local file="${BOT_ID}.json"
    if (( DRY_RUN )); then
      echo "DRY: aws s3 cp ${src}${file} ${dst}/${file}"
    else
      echo "cp:   ${src}${file} -> ${dst}/${file}"
      aws s3 cp "${src}${file}" "${dst}/${file}" --only-show-errors
    fi
  else
    if (( DRY_RUN )); then
      echo "DRY: aws s3 sync $src $dst"
    else
      echo "sync: $src -> $dst"
      aws s3 sync "$src" "$dst" --no-progress --only-show-errors
    fi
  fi
}

# ── main ─────────────────────────────────────────────────────────────────
echo "trading-blueprint state restore"
echo "  state-dir: $STATE_DIR"
echo "  s3-uri:    $S3_URI"
echo "  hostname:  $HOSTNAME_VAL"
echo "  as-of:     $AS_OF"
echo "  bot-id:    ${BOT_ID:-<all>}"
echo "  kinds:     ${KINDS[*]}"
echo "  dry-run:   $DRY_RUN"
echo "  staging:   $STAGING"
echo

for kind in "${KINDS[@]}"; do
  if [[ "$AS_OF" == "latest" ]]; then
    suffix="$(resolve_latest "$kind")"
    if [[ -z "$suffix" ]]; then
      echo "WARN: no snapshots under ${S3_URI}${kind}/${HOSTNAME_VAL}/" >&2
      continue
    fi
    echo "resolved latest for $kind: $suffix"
  else
    suffix="$AS_OF"
  fi
  restore_kind "$kind" "$suffix"
done

if (( DRY_RUN )); then
  echo
  echo "dry run complete; nothing changed"
  exit 0
fi

# ── atomic swap ──────────────────────────────────────────────────────────
echo
if [[ -n "$BOT_ID" ]]; then
  # Per-bot: copy individual files into place, do not touch other state.
  for kind in "${KINDS[@]}"; do
    [[ "$kind" == "registry" ]] && continue
    src_file="${STAGING}/${kind}/${BOT_ID}.json"
    dst_dir="${STATE_DIR}/${kind}"
    if [[ -f "$src_file" ]]; then
      mkdir -p "$dst_dir"
      mv "$src_file" "${dst_dir}/${BOT_ID}.json"
      echo "restored ${dst_dir}/${BOT_ID}.json"
    fi
  done
else
  # Whole-host: rename staging into place.
  if [[ -d "$STATE_DIR" ]]; then
    BACKUP_DIR="${STATE_DIR}.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$STATE_DIR" "$BACKUP_DIR"
    echo "moved existing state aside: $BACKUP_DIR"
  fi
  mv "$STAGING" "$STATE_DIR"
  trap - EXIT  # staging was consumed
  echo "restored $STATE_DIR"
fi

echo
echo "restore complete"
