#!/usr/bin/env bash
# backup-state.sh — snapshot trading-blueprint state to S3.
#
# Snapshots the per-bot envelope storage, learning state, and bot registry
# from <state_dir> to s3://<bucket>/<kind>/<hostname>/<timestamp>/. Driven
# by trading-envelope-backup.timer (see docs/disaster-recovery.md §2.3).
#
# Usage:
#   backup-state.sh \
#     --state-dir /var/lib/trading-blueprint/state \
#     --s3-uri s3://my-bucket/ \
#     --hostname host-01
#
# Options:
#   --state-dir DIR      Source state directory (required).
#   --s3-uri URI         S3 bucket URI, e.g. s3://my-bucket/ (required).
#   --hostname HOST      Hostname suffix in S3 path (default: $(hostname)).
#   --tag TAG            Optional tag appended to the timestamp dir.
#   --dry-run            Print what would be uploaded without doing it.
#   -h, --help           Show this help and exit.
#
# Required tools: aws-cli, jq, tar.
# Required IAM:   s3:PutObject on the destination bucket. NOT s3:DeleteObject.

set -euo pipefail

# ── arg parse ────────────────────────────────────────────────────────────
STATE_DIR=""
S3_URI=""
HOSTNAME_OVERRIDE=""
TAG=""
DRY_RUN=0

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --s3-uri)    S3_URI="$2"; shift 2 ;;
    --hostname)  HOSTNAME_OVERRIDE="$2"; shift 2 ;;
    --tag)       TAG="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -z "$STATE_DIR" || -z "$S3_URI" ]] && { echo "ERROR: --state-dir and --s3-uri are required" >&2; usage 1; }
[[ ! -d "$STATE_DIR" ]] && { echo "ERROR: state dir not found: $STATE_DIR" >&2; exit 2; }

HOST="${HOSTNAME_OVERRIDE:-$(hostname)}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX="$TS"
[[ -n "$TAG" ]] && SUFFIX="${TS}-${TAG}"

# ── tool checks ──────────────────────────────────────────────────────────
for tool in aws jq tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found in PATH" >&2; exit 3; }
done

S3_URI="${S3_URI%/}/" # ensure trailing slash

# ── upload helpers ───────────────────────────────────────────────────────
sync_kind() {
  local kind="$1"
  local src="$STATE_DIR/$kind"
  local dst="${S3_URI}${kind}/${HOST}/${SUFFIX}/"

  if [[ ! -d "$src" ]]; then
    echo "skip: $src does not exist (kind=$kind)"
    return 0
  fi

  if (( DRY_RUN )); then
    echo "DRY: aws s3 sync $src $dst"
  else
    echo "sync: $src -> $dst"
    aws s3 sync "$src" "$dst" --no-progress --only-show-errors
  fi
}

upload_file() {
  local kind="$1"
  local relpath="$2"
  local src="$STATE_DIR/$relpath"
  local dst="${S3_URI}${kind}/${HOST}/${SUFFIX}/${relpath}"

  if [[ ! -f "$src" ]]; then
    echo "skip: $src does not exist (kind=$kind)"
    return 0
  fi

  if (( DRY_RUN )); then
    echo "DRY: aws s3 cp $src $dst"
  else
    echo "cp:   $src -> $dst"
    aws s3 cp "$src" "$dst" --no-progress --only-show-errors
  fi
}

# ── version stamp ────────────────────────────────────────────────────────
record_version() {
  local kind="registry"
  local dst="${S3_URI}${kind}/${HOST}/${SUFFIX}/version.txt"
  local content
  content="$(trading-blueprint --version 2>/dev/null || echo unknown)"

  if (( DRY_RUN )); then
    echo "DRY: write version.txt -> $dst (content: $content)"
  else
    echo "$content" | aws s3 cp - "$dst" --only-show-errors
  fi
}

# ── main ─────────────────────────────────────────────────────────────────
echo "trading-blueprint state backup"
echo "  state-dir: $STATE_DIR"
echo "  s3-uri:    $S3_URI"
echo "  hostname:  $HOST"
echo "  timestamp: $SUFFIX"
echo "  dry-run:   $DRY_RUN"
echo

sync_kind "trading-envelopes"
sync_kind "learning"
upload_file "registry" "trading-bots.json"
upload_file "registry" "activation-progress.json"
record_version

echo
echo "backup complete"
