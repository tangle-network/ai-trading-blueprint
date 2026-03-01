import type { Address } from 'viem';
import type { ProvisionPhase } from '~/lib/stores/provisions';

// ── Wizard types ────────────────────────────────────────────────────────

export type WizardStep = 'blueprint' | 'configure' | 'deploy' | 'secrets';

export const STEP_ORDER: WizardStep[] = ['blueprint', 'configure', 'deploy', 'secrets'];
export const STEP_LABELS: Record<WizardStep, string> = {
  blueprint: 'Blueprint',
  configure: 'Configure',
  deploy: 'Provision',
  secrets: 'Activate',
};

/** Maps Rust provision progress phases to human-readable labels */
export const PROVISION_PROGRESS_LABELS: Record<string, string> = {
  queued: 'Preparing environment...',
  image_pull: 'Pulling container image...',
  container_create: 'Launching container (this may take 10-30s)...',
  container_start: 'Container ready, finalizing configuration...',
  health_check: 'Saving bot configuration...',
  ready: 'Submitting on-chain result...',
};

// ── Service types ───────────────────────────────────────────────────────

export interface ServiceInfo {
  blueprintId: number;
  owner: Address;
  operators: Address[];
  operatorCount: number;
  ttl: number;
  createdAt: number;
  status: number; // 0=Pending, 1=Active, 2=Terminated
  isActive: boolean;
  isPermitted: boolean;
  blueprintMismatch: boolean;
}

export interface DiscoveredService {
  serviceId: number;
  isActive: boolean;
  isPermitted: boolean;
  isOwner: boolean;
  owner: Address;
  operatorCount: number;
}

// ── Helper functions ────────────────────────────────────────────────────

export function phaseLabel(phase: ProvisionPhase): string {
  switch (phase) {
    case 'pending_confirmation':
      return 'Confirming';
    case 'job_submitted':
      return 'Submitted';
    case 'job_processing':
      return 'Processing';
    case 'awaiting_secrets':
      return 'Needs Config';
    case 'active':
      return 'Active';
    case 'failed':
      return 'Failed';
  }
}

export function phaseDotClass(phase: ProvisionPhase): string {
  switch (phase) {
    case 'pending_confirmation':
      return 'bg-amber-400 animate-pulse';
    case 'job_submitted':
      return 'bg-amber-400 animate-pulse';
    case 'job_processing':
      return 'bg-amber-400 animate-pulse';
    case 'awaiting_secrets':
      return 'bg-amber-400';
    case 'active':
      return 'bg-arena-elements-icon-success';
    case 'failed':
      return 'bg-crimson-400';
  }
}

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

/** Format a scaled cost (USD * 10^9) to human-readable USD string. */
export function formatCost(scaled: bigint): string {
  const usd = Number(scaled) / 1e9;
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export function cronToHuman(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length < 6) return cron;
  const min = parts[1];
  if (min.startsWith('*/')) {
    const n = parseInt(min.slice(2));
    return n === 1 ? '1 min' : `${n} min`;
  }
  return cron;
}
