/**
 * Operator-onboarding config builders.
 *
 * Everything here is derived from the blueprint's real install path so the
 * onboarding screen never emits invented config:
 *  - access policy env (`TRADING_REQUESTER_ACCESS_MODE` / `TRADING_REQUESTER_ALLOWLIST`)
 *    and capacity (`OPERATOR_MAX_CAPACITY`) come from
 *    `trading-blueprint-lib/src/request_access.rs` + `registration.rs`;
 *  - the install command, ports, paths and image come from `Dockerfile`,
 *    `deploy/docker-compose.yml`, `deploy/setup-hetzner.sh` and
 *    `settings.env.example`.
 *
 * These env are enforced fail-closed on the AUTHORITATIVE provision path
 * (`ensure_provision_allowed` → `ensure_requester_allowed` + `capacity_allows`),
 * not just advertised in `/api/meta`.
 */

export type AccessMode = 'allowlist' | 'public';

/**
 * Strategy tags an operator can advertise (TLV field 3 of the registration
 * payload, `SUPPORTED_STRATEGIES`, comma-separated). Sourced from the canonical
 * {@link import('~/lib/types/bot').StrategyType} union so the directory and
 * provision flow speak the same vocabulary.
 */
export const OPERATOR_STRATEGY_OPTIONS = [
  { id: 'momentum', label: 'Momentum' },
  { id: 'mean-reversion', label: 'Mean reversion' },
  { id: 'trend-following', label: 'Trend following' },
  { id: 'arbitrage', label: 'Arbitrage' },
  { id: 'market-making', label: 'Market making' },
  { id: 'hyperliquid_perp', label: 'Hyperliquid perps' },
  { id: 'dex', label: 'DEX spot' },
  { id: 'yield', label: 'Yield' },
  { id: 'prediction', label: 'Prediction markets' },
  { id: 'volatility', label: 'Volatility' },
  { id: 'sentiment', label: 'Sentiment' },
] as const;

export type OperatorStrategyId = (typeof OPERATOR_STRATEGY_OPTIONS)[number]['id'];

/** Default operator API port (admin-facing) — `settings.env.example` / compose. */
export const OPERATOR_API_PORT = 9200;
/** Default trading HTTP API port (bot-facing) — `settings.env.example` / compose. */
export const TRADING_API_PORT = 9100;

/** Sidecar image used to run per-bot harness containers (`settings.env.example`). */
export const SIDECAR_IMAGE = 'ghcr.io/tangle-network/blueprint-sidecar:all-harness';

/** Release-binary download path used by `deploy/setup-hetzner.sh`. */
export const RELEASE_BINARY_URL =
  'https://github.com/tangle-network/ai-trading-blueprint/releases/download/${VERSION}/trading-blueprint-linux-amd64';

/**
 * Match the Rust `normalize_address`: requires `0x` + 40 hex chars, lowercased.
 * Returns `null` for anything that wouldn't survive the operator's own
 * normalization (so the allowlist the operator pastes is the allowlist the node
 * will actually enforce).
 */
export function normalizeOperatorAddress(value: string): string | null {
  const trimmed = value.trim();
  const body =
    trimmed.startsWith('0x') || trimmed.startsWith('0X')
      ? trimmed.slice(2)
      : null;
  if (body === null) return null;
  if (body.length !== 40) return null;
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  return `0x${body.toLowerCase()}`;
}

export interface AllowlistParseResult {
  /** De-duplicated, normalized addresses (sorted, matching the Rust BTreeSet). */
  valid: string[];
  /** Raw tokens that failed `normalizeOperatorAddress`. */
  invalid: string[];
}

/**
 * Split on commas / whitespace / newlines (matching the Rust env parser),
 * normalize, de-dupe, and partition into valid/invalid so the UI can show the
 * operator exactly which entries the node will reject before they deploy.
 */
export function parseAllowlist(raw: string): AllowlistParseResult {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeOperatorAddress(token);
    if (normalized) {
      valid.add(normalized);
    } else {
      invalid.push(token);
    }
  }
  return {
    valid: Array.from(valid).sort(),
    invalid,
  };
}

export interface OperatorEnvConfig {
  accessMode: AccessMode;
  allowlist: string[];
  /** Advertised max concurrent agents. 0 / undefined ⇒ unlimited. */
  maxCapacity?: number;
  /** Publicly reachable operator API endpoint (advertised on-chain + in `/meta`). */
  apiEndpoint?: string;
  operatorAddress?: string;
  strategies: OperatorStrategyId[];
}

/**
 * Render the env block the operator drops into `.env`. Only emits keys with a
 * real value; capacity `0`/unset stays out so the node reads it as unlimited.
 */
export function buildOperatorEnvBlock(config: OperatorEnvConfig): string {
  const lines: string[] = [];
  lines.push(`TRADING_REQUESTER_ACCESS_MODE=${config.accessMode}`);
  if (config.accessMode === 'allowlist') {
    lines.push(`TRADING_REQUESTER_ALLOWLIST=${config.allowlist.join(',')}`);
  }
  if (config.maxCapacity && config.maxCapacity > 0) {
    lines.push(`OPERATOR_MAX_CAPACITY=${config.maxCapacity}`);
  }
  if (config.operatorAddress) {
    lines.push(`OPERATOR_ADDRESS=${config.operatorAddress}`);
  }
  if (config.apiEndpoint) {
    lines.push(`OPERATOR_API_ENDPOINT=${normalizeEndpoint(config.apiEndpoint)}`);
  }
  if (config.strategies.length > 0) {
    lines.push(`SUPPORTED_STRATEGIES=${config.strategies.join(',')}`);
  }
  lines.push(`OPERATOR_API_PORT=${OPERATOR_API_PORT}`);
  lines.push(`TRADING_API_PORT=${TRADING_API_PORT}`);
  lines.push(`SIDECAR_IMAGE=${SIDECAR_IMAGE}`);
  return lines.join('\n');
}

/** Strip a trailing slash so the endpoint matches how `/meta` advertises it. */
export function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * The copy-pasteable bring-up sequence for the operator's own VM. Mirrors
 * `deploy/setup-hetzner.sh` + `deploy/docker-compose.yml`: write the env, pull
 * the deploy compose, bring the stack up. Kept declarative (no invented flags)
 * so it stays honest against the repo.
 */
export function buildInstallCommand(envBlock: string): string {
  return [
    '# 1. Provision the host (Docker + 50GB state volume):',
    './deploy/setup-hetzner.sh trading-operator <ssh-key-name>',
    '',
    '# 2. On the operator host, write the env and bring the stack up:',
    'mkdir -p /opt/trading-blueprint && cd /opt/trading-blueprint',
    "cat > .env <<'EOF'",
    envBlock,
    'EOF',
    'chmod 600 .env',
    'docker compose up -d',
    '',
    `# Operator API:  http://<host>:${OPERATOR_API_PORT}  (health: /health, policy: /api/meta)`,
    `# Trading API:   http://<host>:${TRADING_API_PORT}   (agent-facing)`,
  ].join('\n');
}
