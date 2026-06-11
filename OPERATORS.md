# Running a Trading Blueprint Operator

This guide takes you from a bare Linux VPS to a registered, serving operator
for the AI trading blueprints on Tangle (Base Sepolia) in about 30 minutes,
using one script: [`deploy/operator-install.sh`](deploy/operator-install.sh).

You can run either fleet shape:

| Blueprint ID | Binary | Shape |
|---|---|---|
| **13** (default) | `trading-blueprint` | Cloud fleet — many bots per operator instance |
| **14** | `trading-instance-blueprint` | Instance — one bot per service |
| **15** | `trading-tee-instance-blueprint` | TEE instance (requires TEE hardware; not covered here) |

Your operator serves bots in Docker sandboxes, exposes an operator API that
the [Arena UI](https://trading-arena.blueprint.tangle.tools) discovers through
your on-chain registration, and runs deterministic strategy ticks on a cron.
Bots **paper-trade by default** — real market data, simulated fills, zero
on-chain trades — until you deliberately flip them live.

## Requirements

| | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 40 GB SSD | 80 GB SSD (sidecar image is multi-GB; bots accumulate state) |
| OS | Ubuntu 22.04/24.04 (any systemd distro; the TLS step assumes `apt`) | |
| Arch | x86_64 (releases currently publish x86_64 only — see [Troubleshooting](#troubleshooting) for aarch64) | |
| Docker | Engine 24+, daemon running | |
| Network | Public IPv4; inbound 22 + 443 open | |

Install Docker first if missing: `curl -fsSL https://get.docker.com | sh && systemctl enable --now docker`

## Install

```bash
curl -fsSL https://github.com/tangle-network/ai-trading-blueprint/archive/refs/heads/main.tar.gz | tar -xz
cd ai-trading-blueprint-main
sudo ./deploy/operator-install.sh --dry-run   # inspect the plan first
sudo ./deploy/operator-install.sh             # install
```

The script is idempotent — re-run it any time; it skips finished steps and
never overwrites your `settings.env` or keystore. What it does:

1. Checks dependencies (`docker`, `curl`, `jq`, `openssl`, `xz`, systemd).
2. Downloads the release binary for your `--tag` (default: latest GitHub
   release) and **verifies its sha256** against the published checksum.
3. Generates an operator key if you don't have one (or imports
   `OPERATOR_PRIVATE_KEY` from the environment), stores it in the keystore +
   `settings.env` (both `chmod 600`), and prints **only the address**.
4. Writes `settings.env` from
   [`deploy/operator-settings.env.template`](deploy/operator-settings.env.template)
   with fail-closed defaults: allowlist admission, paper trading, capped
   capacity.
5. Pre-pulls the public sidecar image
   `ghcr.io/tangle-network/blueprint-sidecar:all-harness` (bot sandboxes).
6. Installs + enables the `trading-operator` systemd unit
   (`EnvironmentFile=settings.env`, binary under `<data-dir>/bin/`).
7. Configures TLS via Caddy at `--domain`, falling back to
   `https://<your-ip>.sslip.io` (skip with `--no-tls`).
8. Health-checks `GET /health` and prints your public API URL.

Flags:

```
--tag vX.Y.Z         release to install (default: latest)
--blueprint-id N     13 cloud (default) | 14 instance | 15 TEE
--rpc-url URL        chain HTTP RPC      (default: https://sepolia.base.org)
--ws-rpc-url URL     chain WS RPC        (default: wss://base-sepolia-rpc.publicnode.com)
--data-dir DIR       state root          (default: /var/lib/trading-operator)
--port-api N         operator API port   (default: 9200)
--port-trading N     trading API port    (default: 9100)
--capacity N         max concurrent bots (default: 10)
--domain HOST        TLS hostname        (default: <public-ip>.sslip.io)
--no-tls             skip Caddy
--register           stake + register on-chain (after funding)
--request-service    self-create a service instance (gets you a SERVICE_ID)
--service-id N       use an existing service id instead
--stake-amount WEI   stake for --register (default 1000000000000000000 = 1 TNT)
--dry-run            print the plan, change nothing
```

Put `--data-dir` on a persistent volume if your provider offers detachable
volumes — everything that matters (keystore, settings, bot state) lives under
it, so you can re-attach it to a new VM and re-run the installer to migrate.

## Fund, register, serve

The first run prints your operator address. Fund it, then register:

1. **Gas** — ~0.01 Base Sepolia ETH:
   [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia) or
   [Coinbase faucet](https://portal.cdp.coinbase.com/products/faucet).
2. **Stake** — at least 1 TNT (token
   `0x62b3407a22e50183b1055e54d70ee21f59bf865b` on Base Sepolia). There is no
   public TNT faucet on testnet; request it from the Tangle team
   ([Discord](https://discord.gg/tangle) or hello@tangle.tools).

```bash
sudo ./deploy/operator-install.sh --register --request-service
```

`--register` approves + stakes TNT on the restaking layer, then registers you
on the blueprint, advertising your public API URL on-chain (that's how the
Arena finds you). Both steps are verified against chain state and skipped when
already done. `--request-service` then self-creates a 1-operator service
instance, writes the resulting `SERVICE_ID` into `settings.env`, and starts
the unit. Verify yourself:

```bash
cast call 0x8299d60f373f3a4a8c4878e335cb9d840e6e3730 \
  "isOperatorRegistered(uint64,address)(bool)" 13 <YOUR_ADDRESS> \
  --rpc-url https://sepolia.base.org
curl https://<your-domain>/health
curl https://<your-domain>/api/bots
```

To serve an existing service instead, pass `--service-id N` (or edit
`SERVICE_ID` in `settings.env` and `systemctl restart trading-operator`). The
binary exits immediately if `SERVICE_ID` is unset — that is expected until
this step is done.

## Economics — what you earn, what you pay

Honest current state on Base Sepolia testnet: **expect zero revenue and real
costs.** You are operating to build track record on the leaderboard, not for
testnet fees.

**What you advertise.** The operator API exposes informational pricing at
`GET /pricing/config` and `POST /pricing/quote`. The model is
subscription-style: `SUBSCRIPTION_RATE` (wei) per `SUBSCRIPTION_INTERVAL`
(seconds; defaults 1 gwei / 86400s) covers all jobs on a service, with fixed
relative job weights baked into the contract (provision 50x, configure 2x,
start/stop/deprovision 1x, extend 10x, status free).

**What is actually enforced today.**
- Signed EIP-712 service-creation quotes come from a separate pricing-engine
  gRPC process (`PRICING_ENGINE_ENDPOINT`). This installer does **not** set it
  up — the REST quote endpoints are informational only.
- Optional per-job [x402](https://www.x402.org/) pricing: drop a
  `job_pricing.toml` (`[service_id]` table, `job_index = "price_in_wei"`)
  under `<data-dir>/config/` and set `JOB_PRICING_CONFIG_PATH` in
  `settings.env`. **If absent, x402 jobs are served free** — the operator logs
  "x402 jobs will be free" at startup.
- Service payments flow through tnt-core's fee distributor when a requester
  attaches payment; the self-requested service the installer creates uses
  payment amount 0.

**What you pay.**
- The VPS and disk.
- **AI inference, if you set an API key.** `ZAI_API_KEY` /
  `ANTHROPIC_API_KEY` / `TANGLE_API_KEY` in `settings.env` enable agentic bot
  activation and chat — billed to *your* key, per run. See the warning under
  Safety knobs.

## Safety knobs

These are the levers that bound your exposure. Defaults are fail-closed.

**Admission: `TRADING_REQUESTER_ACCESS_MODE`** (default `allowlist`).
In allowlist mode only addresses in `TRADING_REQUESTER_ALLOWLIST`
(comma-separated, plus your own operator address, always) can request bots.
`public` accepts anyone — every accepted bot consumes a Docker sandbox, CPU,
disk, and (if AI keys are set) your inference budget. Stay on `allowlist`
until you have watched a few bots run.

**Capacity: `OPERATOR_MAX_CAPACITY`** (default 10). Hard cap on concurrent
bots; admission is rejected above it. **Unset or `0` means unlimited** — the
template always pins a value; keep it that way, especially in public mode.

**Paper mode: `DEFAULT_PAPER_TRADE=true`** (template default). New bots
paper-trade: live market data, simulated fills with honest fee/impact/gas
modelling, no on-chain transactions. If this var is *unset*, the default is
derived from the chain id and is **paper only on local dev chains** — on
anything else bots would default to live execution. Do not remove this line
casually. Going live is a deliberate per-bot action through the operator API.

**AI keys = your money, and there is no spend cap.** Today there is **no
built-in per-bot, per-day, or total LLM budget limit** — no token meter, no
kill switch on spend. (An internal cost metric exists for observability; it
does not enforce anything.) If you set an AI key, your effective caps are:
the admission allowlist, `OPERATOR_MAX_CAPACITY`, and your provider's own
billing limits — set a hard cap on the provider side. Leaving AI keys unset
is fully supported: bots still run their deterministic strategy ticks; only
agentic activation/chat features are disabled.

**`TRADING_ENABLE_DIRECT_BOT_CREATE=false`** (keep it). `true` lets
`POST /api/bots` bypass on-chain service creation — local-dev only.

**Network surface.** Caddy terminates TLS on 443 and proxies to the operator
API; ports 9100/9200 should not be exposed publicly. With `ufw`:
`ufw allow 22/tcp && ufw allow 443/tcp && ufw enable`.

## Upgrades

```bash
sudo ./deploy/operator-install.sh --tag v0.1.36
```

Re-running with a new `--tag` downloads + sha256-verifies the new binary and
restarts the unit. Keystore, `settings.env`, and bot state are untouched. Roll
back the same way with the previous tag. Running sidecars keep their old image
until their bot is re-provisioned.

## Monitoring

```bash
journalctl -fu trading-operator          # operator logs
curl -s localhost:9200/health            # liveness
curl -s localhost:9200/api/bots | jq     # bot roster + status
docker ps                                # one sidecar container per bot
journalctl -fu caddy                     # TLS/proxy
```

A healthy operator shows `Starting trading blueprint for service <id>` in the
journal, answers `/health`, and lists bots (possibly `[]`) at `/api/bots`.

## Troubleshooting

**`replacement transaction underpriced` during registration.** Known race:
the blueprint-register tx fires while the staking tx is still in the mempool.
The installer waits for nonce parity and retries with backoff (5 attempts).
If it still fails, wait ~1 minute for the mempool to clear and re-run
`--register` — every step is verified on-chain and skipped once landed.

**Binary won't start: `SERVICE_ID missing`.** Expected until a service
exists. Run `--request-service`, or set `SERVICE_ID` in `settings.env` and
`systemctl restart trading-operator`.

**Stale binary after upgrade.** The installer records the installed tag in
`<data-dir>/bin/.<binary>.tag` and skips matching downloads. To force a
re-download: `rm <data-dir>/bin/.<binary>.tag` and re-run.

**`docker pull` of the sidecar image fails.** The image is public on GHCR but
multi-GB — check free disk (`df -h`, want ~10 GB headroom) and GHCR
reachability. Without the image, bot provisioning fails at sandbox creation.

**aarch64 box.** Releases currently publish `x86_64-unknown-linux-gnu` only.
Either use an x86_64 VPS, or build from source on the box
(`cargo build --release -p trading-blueprint-bin`; on a 4 GB box use
`CARGO_BUILD_JOBS=2` and add swap or the build dies silently) and place the
binary at `<data-dir>/bin/<binary>`.

**Provision requests rejected with 403.** Working as configured: the
requester isn't in `TRADING_REQUESTER_ALLOWLIST`. Add their address (CSV) and
restart, or switch to `public` once you accept the exposure described above.

**Healthy locally but invisible to the Arena.** The Arena reaches you via the
endpoint advertised at registration (`--register` publishes your public URL
on-chain) and via CORS. Check that `https://<domain>/api/bots` works from
outside, port 443 is open, and `CORS_ALLOWED_ORIGINS` in `settings.env` still
includes the Arena origins.

**TLS cert not issued.** Caddy needs your domain to resolve to this box and
port 443 reachable from the internet. The `<ip>.sslip.io` fallback always
resolves; for custom domains create the A record first. `journalctl -fu caddy`
shows ACME progress.
