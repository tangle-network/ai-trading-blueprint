#!/usr/bin/env bash
# operator-install.sh — bare Linux VPS → registered, serving trading-blueprint
# operator. Companion doc: OPERATORS.md (repo root). Idempotent: re-running
# skips completed steps and never overwrites an existing settings.env/keystore.
#
# Usage:
#   sudo ./deploy/operator-install.sh [flags]
#
# Flags:
#   --tag vX.Y.Z         Release tag to install (default: latest GitHub release)
#   --blueprint-id N     13 = cloud fleet (default), 14 = instance, 15 = TEE instance
#   --rpc-url URL        Chain HTTP RPC (default: https://sepolia.base.org)
#   --ws-rpc-url URL     Chain WS RPC (default: wss://base-sepolia-rpc.publicnode.com)
#   --data-dir DIR       Persistent state root (default: /var/lib/trading-operator)
#   --port-api N         Operator API port (default: 9200)
#   --port-trading N     Trading API port (default: 9100)
#   --capacity N         OPERATOR_MAX_CAPACITY (default: 10)
#   --service-id N       Known service id (skip if a service will be created later)
#   --domain HOST        Public hostname for TLS (default: <public-ip>.sslip.io)
#   --no-tls             Skip the Caddy TLS step
#   --register           Stake + register the operator on the blueprint (on-chain)
#   --request-service    Self-request + approve a 1-operator service (on-chain)
#   --stake-amount WEI   Stake for --register (default: 1000000000000000000 = 1 TNT)
#   --dry-run            Print the plan; mutate nothing
#   -h | --help          This help
#
# Env (never passed via argv):
#   OPERATOR_PRIVATE_KEY  0x-hex key to import instead of generating a fresh one.
#                         After first install the key lives in settings.env and
#                         this is no longer needed.
#   GITHUB_TOKEN          Optional, raises GitHub API rate limits.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SLUG="tangle-network/ai-trading-blueprint"
SDK_REPO_SLUG="tangle-network/blueprint"
CARGO_TANGLE_TAG="${CARGO_TANGLE_TAG:-cargo-tangle-v0.5.0-alpha.9}"
MANIFEST_PATH="${TNT_CORE_DEPLOYMENT_MANIFEST:-$SCRIPT_DIR/manifests/base-sepolia/tnt-core.latest.json}"
TEMPLATE_PATH="$SCRIPT_DIR/operator-settings.env.template"
UNIT_NAME="trading-operator"

TAG=""
BLUEPRINT_ID=13
RPC_URL="https://sepolia.base.org"
WS_RPC_URL="wss://base-sepolia-rpc.publicnode.com"
DATA_DIR="/var/lib/trading-operator"
PORT_API=9200
PORT_TRADING=9100
CAPACITY=10
SERVICE_ID=""
DOMAIN=""
TLS=1
DO_REGISTER=0
DO_REQUEST_SERVICE=0
STAKE_AMOUNT="1000000000000000000"
DRY_RUN=0

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
plan() { printf '\033[1;36m[plan]\033[0m %s\n' "$*"; }
run()  { if (( DRY_RUN )); then plan "$*"; else "$@"; fi; }

usage() { sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)             TAG="${2:?--tag needs a value}"; shift 2 ;;
    --blueprint-id)    BLUEPRINT_ID="${2:?}"; shift 2 ;;
    --rpc-url)         RPC_URL="${2:?}"; shift 2 ;;
    --ws-rpc-url)      WS_RPC_URL="${2:?}"; shift 2 ;;
    --data-dir)        DATA_DIR="${2:?}"; shift 2 ;;
    --port-api)        PORT_API="${2:?}"; shift 2 ;;
    --port-trading)    PORT_TRADING="${2:?}"; shift 2 ;;
    --capacity)        CAPACITY="${2:?}"; shift 2 ;;
    --service-id)      SERVICE_ID="${2:?}"; shift 2 ;;
    --domain)          DOMAIN="${2:?}"; shift 2 ;;
    --no-tls)          TLS=0; shift ;;
    --register)        DO_REGISTER=1; shift ;;
    --request-service) DO_REQUEST_SERVICE=1; shift ;;
    --stake-amount)    STAKE_AMOUNT="${2:?}"; shift 2 ;;
    --dry-run)         DRY_RUN=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

case "$BLUEPRINT_ID" in
  13) BINARY="trading-blueprint" ;;
  14) BINARY="trading-instance-blueprint" ;;
  15) BINARY="trading-tee-instance-blueprint" ;;
  *)  BINARY="trading-blueprint"
      warn "blueprint id $BLUEPRINT_ID is not one of the published ids (13/14/15); assuming the cloud binary ($BINARY)" ;;
esac

KEYSTORE_DIR="$DATA_DIR/keystore"
STATE_DIR="$DATA_DIR/blueprint-state"
BIN_DIR="$DATA_DIR/bin"
SETTINGS="$DATA_DIR/settings.env"
UNIT_FILE="/etc/systemd/system/$UNIT_NAME.service"

gh_curl() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$@"
  else
    curl -fsSL "$@"
  fi
}

# ── Step 0: dependency + privilege check ──────────────────────────────────────
log "Step 0: dependencies"
missing=()
for cmd in curl jq openssl tar xz systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
if (( ${#missing[@]} )); then
  die "missing: ${missing[*]} — install with: apt-get update && apt-get install -y curl jq openssl xz-utils tar systemd"
fi
if ! command -v docker >/dev/null 2>&1; then
  die "docker is required (bot sandboxes run as containers) — install with: curl -fsSL https://get.docker.com | sh && systemctl enable --now docker"
fi
if (( ! DRY_RUN )) && ! docker info >/dev/null 2>&1; then
  die "docker daemon is not reachable — start it with: systemctl enable --now docker"
fi
if (( ! DRY_RUN )) && [[ "$(id -u)" != "0" ]]; then
  die "run as root (writes systemd units + $DATA_DIR). --dry-run works unprivileged."
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  TARGET="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64) TARGET="aarch64-unknown-linux-gnu" ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

# ── Protocol addresses (vendored tnt-core manifest, env-overridable) ─────────
[[ -f "$MANIFEST_PATH" ]] || die "tnt-core manifest not found: $MANIFEST_PATH (run from a repo checkout, or set TNT_CORE_DEPLOYMENT_MANIFEST)"
TANGLE_CONTRACT="${TANGLE_CONTRACT:-$(jq -r '.tangle' "$MANIFEST_PATH")}"
STAKING_CONTRACT="${STAKING_CONTRACT:-$(jq -r '.staking' "$MANIFEST_PATH")}"
STATUS_REGISTRY_CONTRACT="${STATUS_REGISTRY_CONTRACT:-$(jq -r '.statusRegistry' "$MANIFEST_PATH")}"
TNT_TOKEN="${TNT_TOKEN:-$(jq -r '.tntToken' "$MANIFEST_PATH")}"
CHAIN_ID="${CHAIN_ID:-$(jq -r '.chainId' "$MANIFEST_PATH")}"
for v in TANGLE_CONTRACT STAKING_CONTRACT STATUS_REGISTRY_CONTRACT CHAIN_ID; do
  [[ -n "${!v}" && "${!v}" != "null" ]] || die "$v missing from manifest $MANIFEST_PATH"
done
log "Tangle=$TANGLE_CONTRACT staking=$STAKING_CONTRACT chain=$CHAIN_ID blueprint=$BLUEPRINT_ID binary=$BINARY"

if actual_chain="$(curl -fsS -m 10 -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" | jq -r '.result' 2>/dev/null)"; then
  actual_chain=$(( actual_chain ))
  [[ "$actual_chain" == "$CHAIN_ID" ]] || die "chain id mismatch: $RPC_URL reports $actual_chain, expected $CHAIN_ID"
else
  die "RPC unreachable: $RPC_URL"
fi

# ── Step 1: resolve release tag ───────────────────────────────────────────────
log "Step 1: release tag"
if [[ -z "$TAG" ]]; then
  TAG="$(gh_curl "https://api.github.com/repos/$REPO_SLUG/releases/latest" | jq -r '.tag_name // empty')"
  [[ -n "$TAG" ]] || die "could not resolve latest release tag (GitHub API rate limit? pass --tag vX.Y.Z or set GITHUB_TOKEN)"
fi
log "installing $BINARY @ $TAG ($TARGET)"

# ── Step 2: directories ───────────────────────────────────────────────────────
log "Step 2: directories under $DATA_DIR"
run mkdir -p "$BIN_DIR" "$STATE_DIR" "$KEYSTORE_DIR" "$DATA_DIR/config"
run chmod 700 "$STATE_DIR" "$KEYSTORE_DIR"

# ── Step 3: download + verify the operator binary ─────────────────────────────
log "Step 3: operator binary"
INSTALLED_TAG_FILE="$BIN_DIR/.${BINARY}.tag"
if [[ -f "$INSTALLED_TAG_FILE" && "$(cat "$INSTALLED_TAG_FILE")" == "$TAG" && -x "$BIN_DIR/$BINARY" ]]; then
  log "$BINARY $TAG already installed — skipping download"
elif (( DRY_RUN )); then
  plan "download https://github.com/$REPO_SLUG/releases/download/$TAG/${BINARY}-${TARGET}.tar.xz (+ .sha256), verify, extract to $BIN_DIR/$BINARY"
else
  ASSET="${BINARY}-${TARGET}.tar.xz"
  URL="https://github.com/$REPO_SLUG/releases/download/$TAG/$ASSET"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if ! curl -fsSL "$URL" -o "$TMP/$ASSET"; then
    die "download failed: $URL
Releases currently publish ${TARGET%%-*}=x86_64 only — on $ARCH either pick a tag that shipped your arch or build from source (see OPERATORS.md troubleshooting)."
  fi
  curl -fsSL "$URL.sha256" -o "$TMP/$ASSET.sha256" || die "checksum sidecar missing: $URL.sha256"
  (cd "$TMP" && sha256sum -c "$ASSET.sha256") || die "sha256 verification FAILED for $ASSET — refusing to install"
  tar -xJf "$TMP/$ASSET" -C "$BIN_DIR"
  chmod +x "$BIN_DIR/$BINARY"
  echo "$TAG" > "$INSTALLED_TAG_FILE"
  log "installed $BIN_DIR/$BINARY ($(du -h "$BIN_DIR/$BINARY" | cut -f1))"
fi

# ── Helpers: cast + cargo-tangle (fetched on demand, sha256-verified) ─────────
ensure_cast() {
  command -v cast >/dev/null 2>&1 && return 0
  [[ -x "$HOME/.foundry/bin/cast" ]] && { export PATH="$HOME/.foundry/bin:$PATH"; return 0; }
  if (( DRY_RUN )); then plan "install foundry (cast) via foundryup"; return 0; fi
  log "installing foundry (cast)"
  curl -fsSL https://foundry.paradigm.xyz | bash >/dev/null 2>&1 || die "foundryup bootstrap failed — install foundry manually: https://getfoundry.sh"
  "$HOME/.foundry/bin/foundryup" >/dev/null 2>&1 || die "foundryup failed — install foundry manually: https://getfoundry.sh"
  export PATH="$HOME/.foundry/bin:$PATH"
  command -v cast >/dev/null 2>&1 || die "cast still not on PATH after foundryup"
}

ensure_cargo_tangle() {
  if command -v cargo-tangle >/dev/null 2>&1; then CARGO_TANGLE="$(command -v cargo-tangle)"; return 0; fi
  CARGO_TANGLE="$BIN_DIR/cargo-tangle"
  [[ -x "$CARGO_TANGLE" ]] && return 0
  if (( DRY_RUN )); then plan "download cargo-tangle ($CARGO_TANGLE_TAG, $TARGET) from github.com/$SDK_REPO_SLUG releases, sha256-verify, install to $CARGO_TANGLE"; return 0; fi
  log "installing cargo-tangle ($CARGO_TANGLE_TAG)"
  local asset="cargo-tangle-${TARGET}.tar.xz"
  local url="https://github.com/$SDK_REPO_SLUG/releases/download/$CARGO_TANGLE_TAG/$asset"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/$asset" || die "cargo-tangle download failed: $url"
  curl -fsSL "$url.sha256" -o "$tmp/$asset.sha256" || die "cargo-tangle checksum missing: $url.sha256"
  (cd "$tmp" && sha256sum -c "$asset.sha256") || die "sha256 verification FAILED for cargo-tangle"
  tar -xJf "$tmp/$asset" -C "$tmp"
  install -m 755 "$(find "$tmp" -name cargo-tangle -type f | head -1)" "$CARGO_TANGLE"
  rm -rf "$tmp"
}

# ── Step 4: keystore + operator identity ──────────────────────────────────────
log "Step 4: operator key"
PRIVATE_KEY=""
OPERATOR_ADDRESS=""
if [[ -f "$SETTINGS" ]]; then
  PRIVATE_KEY="$(sed -n 's/^PRIVATE_KEY=//p' "$SETTINGS" | head -1)"
  OPERATOR_ADDRESS="$(sed -n 's/^OPERATOR_ADDRESS=//p' "$SETTINGS" | head -1)"
fi
if [[ -z "$PRIVATE_KEY" ]]; then
  PRIVATE_KEY="${OPERATOR_PRIVATE_KEY:-}"
fi

FRESH_KEY=0
if [[ -z "$PRIVATE_KEY" ]]; then
  if (( DRY_RUN )); then
    plan "generate operator key (openssl rand), import into keystore at $KEYSTORE_DIR, print address + funding instructions"
    OPERATOR_ADDRESS="0x<generated-on-real-run>"
  else
    PRIVATE_KEY="0x$(openssl rand -hex 32)"
    FRESH_KEY=1
  fi
fi

if (( ! DRY_RUN )); then
  ensure_cast
  derived="$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null)" || die "operator private key is invalid (source: ${OPERATOR_PRIVATE_KEY:+OPERATOR_PRIVATE_KEY env}${OPERATOR_PRIVATE_KEY:-settings.env/generated})"
  if [[ -n "$OPERATOR_ADDRESS" && "${OPERATOR_ADDRESS,,}" != "${derived,,}" ]]; then
    die "settings.env OPERATOR_ADDRESS ($OPERATOR_ADDRESS) does not match PRIVATE_KEY-derived address ($derived) — fix settings.env before continuing"
  fi
  OPERATOR_ADDRESS="$derived"
  if [[ -z "$(find "$KEYSTORE_DIR" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
    ensure_cargo_tangle
    "$CARGO_TANGLE" tangle key import --key-type ecdsa \
      --secret "${PRIVATE_KEY#0x}" --keystore-path "$KEYSTORE_DIR" --protocol tangle >/dev/null
    log "keystore initialized at $KEYSTORE_DIR"
  fi
fi
log "operator address: $OPERATOR_ADDRESS"
if (( FRESH_KEY )); then
  cat <<EOF

  A NEW operator key was generated. It is stored ONLY in:
    $SETTINGS (chmod 600) and $KEYSTORE_DIR
  Back both up. The private key is never printed.

  Fund $OPERATOR_ADDRESS before --register:
    1. Base Sepolia ETH for gas (~0.01 ETH): https://www.alchemy.com/faucets/base-sepolia
    2. >= $STAKE_AMOUNT wei of TNT ($TNT_TOKEN) for the operator stake.
       Testnet TNT has no public faucet — request it from the Tangle team
       (https://discord.gg/tangle or hello@tangle.tools).

EOF
fi

# ── Step 5: settings.env ──────────────────────────────────────────────────────
log "Step 5: settings.env"
PUBLIC_IP="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || true)"
if [[ -z "$DOMAIN" && "$TLS" == "1" ]]; then
  [[ -n "$PUBLIC_IP" ]] || die "could not detect public IP for the sslip.io TLS fallback — pass --domain or --no-tls"
  DOMAIN="${PUBLIC_IP}.sslip.io"
fi
if [[ "$TLS" == "1" ]]; then
  OPERATOR_API_ENDPOINT="https://$DOMAIN"
else
  OPERATOR_API_ENDPOINT="http://${PUBLIC_IP:-127.0.0.1}:$PORT_API"
fi

if [[ -f "$SETTINGS" ]]; then
  log "settings.env exists — leaving it untouched (template: $TEMPLATE_PATH)"
  EXISTING_SERVICE_ID="$(sed -n 's/^SERVICE_ID=//p' "$SETTINGS" | head -1)"
  if [[ -z "$SERVICE_ID" && -n "$EXISTING_SERVICE_ID" ]]; then
    SERVICE_ID="$EXISTING_SERVICE_ID"
  fi
elif (( DRY_RUN )); then
  plan "write $SETTINGS from $TEMPLATE_PATH (allowlist admission, paper mode, capacity=$CAPACITY, endpoint=$OPERATOR_API_ENDPOINT), chmod 600"
else
  [[ -f "$TEMPLATE_PATH" ]] || die "settings template not found: $TEMPLATE_PATH"
  # Stable session-auth secret: the binary refuses to start with an empty one.
  SESSION_AUTH_SECRET="$(openssl rand -hex 32)"
  sed -e "s|@BLUEPRINT_ID@|$BLUEPRINT_ID|g" \
      -e "s|@SERVICE_ID@|$SERVICE_ID|g" \
      -e "s|@CHAIN_ID@|$CHAIN_ID|g" \
      -e "s|@TANGLE_CONTRACT@|$TANGLE_CONTRACT|g" \
      -e "s|@STAKING_CONTRACT@|$STAKING_CONTRACT|g" \
      -e "s|@STATUS_REGISTRY_CONTRACT@|$STATUS_REGISTRY_CONTRACT|g" \
      -e "s|@HTTP_RPC_URL@|$RPC_URL|g" \
      -e "s|@WS_RPC_URL@|$WS_RPC_URL|g" \
      -e "s|@PRIVATE_KEY@|$PRIVATE_KEY|g" \
      -e "s|@OPERATOR_ADDRESS@|$OPERATOR_ADDRESS|g" \
      -e "s|@KEYSTORE_DIR@|$KEYSTORE_DIR|g" \
      -e "s|@BLUEPRINT_STATE_DIR@|$STATE_DIR|g" \
      -e "s|@OPERATOR_API_PORT@|$PORT_API|g" \
      -e "s|@TRADING_API_PORT@|$PORT_TRADING|g" \
      -e "s|@OPERATOR_API_ENDPOINT@|$OPERATOR_API_ENDPOINT|g" \
      -e "s|@OPERATOR_MAX_CAPACITY@|$CAPACITY|g" \
      -e "s|@SESSION_AUTH_SECRET@|$SESSION_AUTH_SECRET|g" \
      -e "s|@DATA_DIR@|$DATA_DIR|g" \
      "$TEMPLATE_PATH" > "$SETTINGS"
  chmod 600 "$SETTINGS"
  log "wrote $SETTINGS (admission=allowlist, paper mode, capacity=$CAPACITY)"
fi

# ── Step 6: sidecar image ─────────────────────────────────────────────────────
log "Step 6: sidecar image"
SIDECAR_IMAGE="$( { [[ -f "$SETTINGS" ]] && sed -n 's/^SIDECAR_IMAGE=//p' "$SETTINGS" | head -1; } || true)"
SIDECAR_IMAGE="${SIDECAR_IMAGE:-ghcr.io/tangle-network/blueprint-sidecar:all-harness}"
if (( DRY_RUN )); then
  plan "docker pull $SIDECAR_IMAGE (public GHCR image, multi-GB — pre-pulled so the first bot provision doesn't time out)"
elif docker image inspect "$SIDECAR_IMAGE" >/dev/null 2>&1; then
  log "$SIDECAR_IMAGE already present"
else
  log "pulling $SIDECAR_IMAGE (multi-GB, one-time)"
  docker pull "$SIDECAR_IMAGE" || die "docker pull $SIDECAR_IMAGE failed — check disk space (needs ~10 GB free) and GHCR reachability"
fi

# ── Step 7: systemd unit ──────────────────────────────────────────────────────
log "Step 7: systemd unit ($UNIT_FILE)"
if (( DRY_RUN )); then
  plan "write $UNIT_FILE (ExecStart=$BIN_DIR/$BINARY run … --data-dir $DATA_DIR/bpm-data, EnvironmentFile=$SETTINGS), daemon-reload, enable"
else
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Tangle AI Trading Blueprint Operator (blueprint $BLUEPRINT_ID)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$DATA_DIR
EnvironmentFile=$SETTINGS
ExecStart=$BIN_DIR/$BINARY run -t --pretty --http-rpc-url $RPC_URL --ws-rpc-url $WS_RPC_URL --keystore-uri $KEYSTORE_DIR --data-dir $DATA_DIR/bpm-data --chain testnet --protocol tangle
Restart=always
RestartSec=10
TimeoutStopSec=60
KillSignal=SIGTERM
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA_DIR /var/run/docker.sock /tmp
PrivateTmp=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$UNIT_NAME

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1
fi

# ── Step 8: TLS via Caddy ─────────────────────────────────────────────────────
if [[ "$TLS" == "1" ]]; then
  log "Step 8: TLS ($DOMAIN → 127.0.0.1:$PORT_API)"
  CADDY_MARKER="# managed-by: trading-operator-install"
  if (( DRY_RUN )); then
    plan "install caddy (official apt repo) if missing; write /etc/caddy/Caddyfile for https://$DOMAIN; reload caddy"
  else
    if ! command -v caddy >/dev/null 2>&1; then
      apt-get update -qq
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq
      apt-get install -y -qq caddy >/dev/null || die "caddy install failed — rerun with --no-tls and front the API yourself"
    fi
    if [[ -f /etc/caddy/Caddyfile ]] && ! grep -q "$CADDY_MARKER" /etc/caddy/Caddyfile; then
      cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.pre-trading-operator.bak"
      warn "existing /etc/caddy/Caddyfile backed up to Caddyfile.pre-trading-operator.bak"
    fi
    cat > /etc/caddy/Caddyfile <<EOF
$CADDY_MARKER
$DOMAIN {
	encode gzip
	request_body {
		max_size 5MB
	}
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy 127.0.0.1:$PORT_API
}
EOF
    systemctl enable caddy >/dev/null 2>&1 || true
    systemctl restart caddy || die "caddy failed to start — journalctl -u caddy"
  fi
else
  log "Step 8: TLS skipped (--no-tls)"
fi

# ── On-chain helpers (registration + service creation) ────────────────────────
wait_mempool_idle() {
  # The known gas race: firing the next tx while the previous one is still in
  # the mempool yields "replacement transaction underpriced". Wait until the
  # pending nonce catches up to latest before sending the next tx.
  local deadline=$(( $(date +%s) + 180 )) latest pending
  while (( $(date +%s) < deadline )); do
    latest="$(cast nonce "$OPERATOR_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
    pending="$(cast nonce "$OPERATOR_ADDRESS" --block pending --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
    if [[ -n "$latest" && "$latest" == "$pending" ]]; then return 0; fi
    sleep 3
  done
  warn "mempool still busy after 180s — continuing anyway"
}

retry_gas_race() {
  # Run an on-chain command; retry with backoff on the known nonce/gas races.
  local attempt out
  for attempt in 1 2 3 4 5; do
    if out="$("$@" 2>&1)"; then
      [[ -n "$out" ]] && printf '%s\n' "$out"
      return 0
    fi
    if grep -Eqi 'replacement transaction underpriced|transaction already imported|already known|nonce too low' <<<"$out"; then
      warn "tx race (attempt $attempt/5) — backing off $((attempt * 5))s and waiting for mempool"
      sleep $((attempt * 5))
      wait_mempool_idle
      continue
    fi
    printf '%s\n' "$out" >&2
    return 1
  done
  printf '%s\n' "$out" >&2
  return 1
}

# String-wise decimal compare — wei amounts overflow 64-bit bash arithmetic.
decimal_lt() {
  local l="${1#"${1%%[!0]*}"}" r="${2#"${2%%[!0]*}"}"
  l="${l:-0}"; r="${r:-0}"
  if (( ${#l} != ${#r} )); then (( ${#l} < ${#r} )); else [[ "$l" < "$r" ]]; fi
}

is_staking_operator() {
  [[ "$(cast call "$STAKING_CONTRACT" "isOperator(address)(bool)" "$OPERATOR_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)" == "true" ]]
}
is_blueprint_registered() {
  [[ "$(cast call "$TANGLE_CONTRACT" "isOperatorRegistered(uint64,address)(bool)" "$BLUEPRINT_ID" "$OPERATOR_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)" == "true" ]]
}

# ── Step 9: on-chain registration (--register) ────────────────────────────────
if (( DO_REGISTER )); then
  log "Step 9: on-chain registration (stake + blueprint $BLUEPRINT_ID)"
  if (( DRY_RUN )); then
    plan "check ETH gas + TNT balance of $OPERATOR_ADDRESS"
    plan "approve TNT ($TNT_TOKEN) to staking contract if allowance < $STAKE_AMOUNT"
    plan "cargo-tangle operator register --amount $STAKE_AMOUNT (skip if already staked)"
    plan "wait for mempool idle, then cargo-tangle blueprint register --blueprint-id $BLUEPRINT_ID (retry/backoff on 'replacement transaction underpriced')"
    plan "verify isOperatorRegistered($BLUEPRINT_ID, $OPERATOR_ADDRESS) == true"
  else
    ensure_cast; ensure_cargo_tangle
    eth_balance="$(cast balance "$OPERATOR_ADDRESS" --rpc-url "$RPC_URL")"
    [[ "$eth_balance" != "0" ]] || die "no gas: $OPERATOR_ADDRESS has 0 ETH on chain $CHAIN_ID — fund it, then re-run with --register"

    TANGLE_ARGS=(
      --http-rpc-url "$RPC_URL"
      --ws-rpc-url "$WS_RPC_URL"
      --keystore-path "$KEYSTORE_DIR"
      --tangle-contract "$TANGLE_CONTRACT"
    )
    # cargo-tangle renamed --staking-contract ↔ --restaking-contract across
    # releases, and older builds lack --status-registry-contract entirely.
    # Probe the fetched binary's --help instead of assuming a version.
    register_help="$("$CARGO_TANGLE" tangle operator register --help 2>&1 || true)"
    if grep -q -- '--restaking-contract' <<<"$register_help"; then
      TANGLE_ARGS+=(--restaking-contract "$STAKING_CONTRACT")
    else
      TANGLE_ARGS+=(--staking-contract "$STAKING_CONTRACT")
    fi
    if grep -q -- '--status-registry-contract' <<<"$register_help"; then
      TANGLE_ARGS+=(--status-registry-contract "$STATUS_REGISTRY_CONTRACT")
    fi

    if is_staking_operator; then
      log "already staked on $STAKING_CONTRACT — skipping operator register"
    else
      tnt_balance="$(cast call "$TNT_TOKEN" "balanceOf(address)(uint256)" "$OPERATOR_ADDRESS" --rpc-url "$RPC_URL" | awk '{print $1}')"
      if decimal_lt "${tnt_balance:-0}" "$STAKE_AMOUNT"; then
        die "insufficient TNT stake: have ${tnt_balance:-0}, need $STAKE_AMOUNT wei of $TNT_TOKEN at $OPERATOR_ADDRESS"
      fi
      allowance="$(cast call "$TNT_TOKEN" "allowance(address,address)(uint256)" "$OPERATOR_ADDRESS" "$STAKING_CONTRACT" --rpc-url "$RPC_URL" | awk '{print $1}')"
      if decimal_lt "${allowance:-0}" "$STAKE_AMOUNT"; then
        log "approving $STAKE_AMOUNT TNT to staking contract"
        retry_gas_race cast send "$TNT_TOKEN" "approve(address,uint256)" "$STAKING_CONTRACT" "$STAKE_AMOUNT" \
          --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null
        wait_mempool_idle
      fi
      log "staking $STAKE_AMOUNT wei TNT"
      retry_gas_race "$CARGO_TANGLE" tangle operator register "${TANGLE_ARGS[@]}" --amount "$STAKE_AMOUNT" \
        || warn "operator register returned non-zero (often OperatorAlreadyRegistered) — verifying on-chain"
      is_staking_operator || die "staking registration did not land: isOperator($OPERATOR_ADDRESS)=false on $STAKING_CONTRACT"
    fi

    if is_blueprint_registered; then
      log "already registered on blueprint $BLUEPRINT_ID — skipping"
    else
      # This is the tx that historically lost the gas race when fired straight
      # after staking. Mempool-idle wait + retry_gas_race covers it.
      wait_mempool_idle
      log "registering on blueprint $BLUEPRINT_ID (advertising $OPERATOR_API_ENDPOINT)"
      # --rpc-endpoint is stored on-chain with the registration; UIs (Arena)
      # resolve it to reach this operator's API. Capacity is enforced at
      # runtime via OPERATOR_MAX_CAPACITY in settings.env.
      retry_gas_race "$CARGO_TANGLE" tangle blueprint register "${TANGLE_ARGS[@]}" \
        --blueprint-id "$BLUEPRINT_ID" --rpc-endpoint "$OPERATOR_API_ENDPOINT" \
        || die "blueprint register failed after retries — see output above (if it raced, simply re-run with --register once the mempool clears)"
      is_blueprint_registered || die "blueprint registration did not land: isOperatorRegistered($BLUEPRINT_ID, $OPERATOR_ADDRESS)=false"
    fi
    log "registered: isOperatorRegistered($BLUEPRINT_ID, $OPERATOR_ADDRESS)=true"
  fi
fi

# ── Step 10: self-request a service (--request-service) ───────────────────────
if (( DO_REQUEST_SERVICE )); then
  log "Step 10: request + approve service on blueprint $BLUEPRINT_ID"
  if (( DRY_RUN )); then
    plan "requestService($BLUEPRINT_ID, [$OPERATOR_ADDRESS], 0x, [$OPERATOR_ADDRESS], 0, 0x0, 0, 0) on $TANGLE_CONTRACT"
    plan "approveService(<request id>) and poll serviceCount for the new SERVICE_ID"
    plan "write SERVICE_ID into $SETTINGS"
  elif [[ -n "$SERVICE_ID" ]]; then
    log "SERVICE_ID=$SERVICE_ID already known — skipping service creation"
  else
    ensure_cast
    is_blueprint_registered || die "operator is not registered on blueprint $BLUEPRINT_ID — run with --register first"
    count_before="$(cast call "$TANGLE_CONTRACT" "serviceCount()(uint64)" --rpc-url "$RPC_URL" | awk '{print $1}')"
    request_id="$(cast call "$TANGLE_CONTRACT" "serviceRequestCount()(uint64)" --rpc-url "$RPC_URL" | awk '{print $1}')"
    # Direct cast against the deployed tnt-core 0.13 ABI — mirrors
    # deploy/go-live.sh, which bypasses cargo-tangle here because its
    # requestService selector has drifted from the live diamond before.
    retry_gas_race cast send "$TANGLE_CONTRACT" \
      "requestService(uint64,address[],bytes,address[],uint64,address,uint256,uint8)" \
      "$BLUEPRINT_ID" "[$OPERATOR_ADDRESS]" "0x" "[$OPERATOR_ADDRESS]" 0 \
      "0x0000000000000000000000000000000000000000" 0 0 \
      --gas-limit 3000000 --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null \
      || die "requestService failed for blueprint $BLUEPRINT_ID"
    wait_mempool_idle
    retry_gas_race cast send "$TANGLE_CONTRACT" \
      "approveService((uint64,((uint8,address),uint16)[],uint256[4],uint256[2],(uint8,bytes32,bytes32,uint64)[]))" \
      "($request_id,[],[0,0,0,0],[0,0],[])" \
      --gas-limit 3000000 --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null \
      || die "approveService failed for request $request_id"
    deadline=$(( $(date +%s) + 60 ))
    SERVICE_ID=""
    while (( $(date +%s) < deadline )); do
      count_now="$(cast call "$TANGLE_CONTRACT" "serviceCount()(uint64)" --rpc-url "$RPC_URL" | awk '{print $1}')"
      if (( count_now > count_before )); then SERVICE_ID=$(( count_now - 1 )); break; fi
      sleep 2
    done
    [[ -n "$SERVICE_ID" ]] || die "serviceCount did not advance within 60s — check the approveService tx on a block explorer"
    sed -i "s|^SERVICE_ID=.*|SERVICE_ID=$SERVICE_ID|" "$SETTINGS"
    log "service created: SERVICE_ID=$SERVICE_ID (written to settings.env)"
  fi
fi

# ── Step 11: start + health check ─────────────────────────────────────────────
log "Step 11: start + health"
if (( DRY_RUN )); then
  plan "systemctl restart $UNIT_NAME (only if SERVICE_ID is set), then poll http://127.0.0.1:$PORT_API/health"
  plan "print public URL: $OPERATOR_API_ENDPOINT"
elif [[ -z "$SERVICE_ID" ]]; then
  cat <<EOF

  Installed but NOT started: the binary requires SERVICE_ID and none is set.
  Next steps:
    1. Fund $OPERATOR_ADDRESS (gas + TNT), then: $0 --register --blueprint-id $BLUEPRINT_ID
    2. Create a service:                          $0 --request-service --blueprint-id $BLUEPRINT_ID
    3. (both write/verify settings.env, then start the unit automatically on re-run)
  Or set SERVICE_ID in $SETTINGS yourself and: systemctl start $UNIT_NAME

EOF
else
  systemctl restart "$UNIT_NAME"
  healthy=0
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 "http://127.0.0.1:$PORT_API/health" >/dev/null 2>&1; then healthy=1; break; fi
    sleep 2
  done
  if (( ! healthy )); then
    journalctl -u "$UNIT_NAME" --no-pager -n 25 || true
    die "operator API not healthy on :$PORT_API after 60s — see journal output above (journalctl -fu $UNIT_NAME)"
  fi
  log "operator API healthy on :$PORT_API"
  if [[ "$TLS" == "1" ]]; then
    if curl -fsS -m 10 "https://$DOMAIN/health" >/dev/null 2>&1; then
      log "public endpoint healthy: https://$DOMAIN"
    else
      warn "https://$DOMAIN/health not reachable yet (cert issuance can take ~30s; ensure port 443 is open in your firewall)"
    fi
  fi
  cat <<EOF

════════════════════════════════════════════════════════════════
  TRADING OPERATOR LIVE
  Operator:     $OPERATOR_ADDRESS
  Blueprint:    $BLUEPRINT_ID ($BINARY @ $TAG)
  Service:      $SERVICE_ID
  Public API:   $OPERATOR_API_ENDPOINT
  Settings:     $SETTINGS
════════════════════════════════════════════════════════════════
  Logs:    journalctl -fu $UNIT_NAME
  Health:  curl $OPERATOR_API_ENDPOINT/health
  Bots:    curl $OPERATOR_API_ENDPOINT/api/bots
  Docs:    OPERATORS.md (admission allowlist, AI keys, economics, upgrades)
EOF
fi
