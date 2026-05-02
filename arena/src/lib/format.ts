import type { ProvisionPhase } from '~/lib/stores/provisions';
import type { BotStatus } from '~/lib/types/bot';

// ── Strategy Maps ────────────────────────────────────────────────────────

export const STRATEGY_NAMES: Record<string, string> = {
  dex: 'DEX Spot Trading',
  prediction: 'Prediction Markets',
  prediction_politics: 'Prediction — Politics',
  prediction_crypto: 'Prediction — Crypto',
  prediction_war: 'Prediction — Geopolitics',
  prediction_trending: 'Prediction — Trending',
  prediction_celebrity: 'Prediction — Celebrity',
  yield: 'Yield Optimization',
  perp: 'Perpetual Futures',
  volatility: 'Volatility Trading',
  mm: 'Market Making',
  multi: 'Cross-Strategy',
  momentum: 'Momentum',
  'mean-reversion': 'Mean Reversion',
  arbitrage: 'Arbitrage',
  'trend-following': 'Trend Following',
  'market-making': 'Market Making',
  sentiment: 'Sentiment',
};

export const STRATEGY_SHORT: Record<string, string> = {
  dex: 'DEX',
  prediction: 'Pred',
  prediction_politics: 'Politics',
  prediction_crypto: 'Crypto',
  prediction_war: 'Geopol',
  prediction_trending: 'Trending',
  prediction_celebrity: 'Celeb',
  yield: 'Yield',
  perp: 'Perps',
  volatility: 'Vol',
  mm: 'MM',
  multi: 'Multi',
  momentum: 'Mom',
  'mean-reversion': 'MR',
  arbitrage: 'Arb',
  'trend-following': 'Trend',
  'market-making': 'MM2',
  sentiment: 'Sent',
};

// ── Provision Progress ───────────────────────────────────────────────────

export const PROVISION_STEPS = [
  { key: 'queued', label: 'Init' },
  { key: 'container_create', label: 'Container' },
  { key: 'container_start', label: 'Ready' },
  { key: 'health_check', label: 'Config' },
  { key: 'ready', label: 'Submit' },
] as const;

export const PROGRESS_LABELS: Record<string, string> = {
  queued: 'Preparing environment...',
  image_pull: 'Pulling container image...',
  container_create: 'Launching container...',
  container_start: 'Container ready, configuring...',
  health_check: 'Saving bot configuration...',
  ready: 'Submitting on-chain result...',
};

export function progressPhaseLabel(phase?: string): string | undefined {
  if (!phase) return undefined;
  return PROGRESS_LABELS[phase];
}

export function phaseLabel(phase: ProvisionPhase): string {
  switch (phase) {
    case 'pending_confirmation': return 'Confirming';
    case 'job_submitted': return 'Submitted';
    case 'job_processing': return 'Processing';
    case 'awaiting_secrets': return 'Needs Config';
    case 'active': return 'Active';
    case 'failed': return 'Failed';
  }
}

// ── Time / Format ────────────────────────────────────────────────────────

export function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Expired';
  const days = Math.floor(totalSeconds / 86400);
  const hrs = Math.floor((totalSeconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hrs}h`;
  const mins = Math.floor((totalSeconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

interface FormatNumberOptions {
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  locale?: string;
}

export function normalizeDisplayNumber(value: number, maximumFractionDigits = 2): number {
  if (!Number.isFinite(value)) return value;
  const roundedZeroThreshold = 0.5 / (10 ** Math.max(0, maximumFractionDigits));
  if (Object.is(value, -0) || Math.abs(value) < roundedZeroThreshold) return 0;
  return value;
}

export function formatNumber(value: number, options: FormatNumberOptions = {}): string {
  const {
    maximumFractionDigits = 2,
    minimumFractionDigits = 0,
    locale = 'en-US',
  } = options;

  if (!Number.isFinite(value)) return String(value);
  const displayValue = normalizeDisplayNumber(value, maximumFractionDigits);

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits,
  }).format(displayValue);
}

export function botStatusLabel(status: BotStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'stopped':
      return 'Stopped';
    case 'needs_config':
      return 'Needs Config';
    case 'winding_down':
      return 'Winding Down';
    case 'archived':
      return 'Archived';
    case 'unknown':
      return 'Unknown';
    default:
      return status;
  }
}

export function botStatusBadgeVariant(status: BotStatus): 'success' | 'amber' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'active':
      return 'success';
    case 'paused':
    case 'needs_config':
    case 'winding_down':
      return 'amber';
    case 'unknown':
      return 'outline';
    case 'archived':
    case 'stopped':
    default:
      return 'secondary';
  }
}

export function isActiveSummaryStatus(status: BotStatus): boolean {
  return status === 'active';
}

export function isLiveBotStatus(status: BotStatus): boolean {
  return status === 'active' || status === 'paused' || status === 'winding_down';
}

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

export function isStuck(updatedAt: number, phase: ProvisionPhase): boolean {
  return (phase === 'job_submitted' || phase === 'job_processing') && Date.now() - updatedAt > STUCK_THRESHOLD_MS;
}
