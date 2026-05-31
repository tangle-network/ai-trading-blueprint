import { useEffect, useMemo, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useAccount, useWriteContract } from 'wagmi';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { toast } from 'sonner';
import type { Bot } from '~/lib/types/bot';
import { useBotDetail } from '~/lib/hooks/useBotDetail';
import { useBotControl } from '~/lib/hooks/useBotControl';
import { useBotTrades } from '~/lib/hooks/useBotApi';
import { useBotLiveSummary } from '~/lib/hooks/useBotLiveSummary';
import { useServiceInfo } from '~/lib/hooks/useServiceInfo';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tangle-network/blueprint-ui/components';
import { ScoreRing } from './shared/ValidatorComponents';
import { AssetDisplay } from './shared/AssetDisplay';
import { tangleJobsAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { SkeletonCard } from '~/components/ui/Skeleton';
import { OperatorAccessCard } from '~/components/operator/OperatorAccessCard';
import { BinaryUpdatesPanel } from '~/components/operator/BinaryUpdatesPanel';
import { botStatusBadgeVariant, botStatusLabel, normalizeDisplayNumber } from '~/lib/format';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';
import { getTradeValidationDisplay } from '~/lib/tradeValidation';

const JOB_EXTEND = 6;
const DEFAULT_POSITION_SIZE_PCT = '10';
const MIN_POSITION_SIZE_PCT = 1;
const MAX_POSITION_SIZE_PCT = 100;
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatTimestamp(ts: number): string {
  if (!ts) return 'N/A';
  return new Date(ts * 1000).toLocaleString();
}

function readConfigString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

function readRiskNumber(config: Record<string, unknown> | undefined, key: string, fallback: string): string {
  const value = config?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function readPositionSizePct(config: Record<string, unknown>): string {
  const sizing = config.position_sizing;
  if (!sizing || typeof sizing !== 'object' || Array.isArray(sizing)) {
    return DEFAULT_POSITION_SIZE_PCT;
  }
  const fraction = (sizing as Record<string, unknown>).fraction;
  const numericFraction =
    typeof fraction === 'number'
      ? fraction
      : typeof fraction === 'string'
        ? Number(fraction)
        : Number.NaN;
  return Number.isFinite(numericFraction)
    ? String(Number((numericFraction * 100).toFixed(4)))
    : DEFAULT_POSITION_SIZE_PCT;
}

function validatePositionSizePct(value: string): string | null {
  const pct = Number(value);
  if (!Number.isFinite(pct)) return 'Position size must be a number';
  if (pct < MIN_POSITION_SIZE_PCT || pct > MAX_POSITION_SIZE_PCT) {
    return `Position size must be between ${MIN_POSITION_SIZE_PCT}% and ${MAX_POSITION_SIZE_PCT}%`;
  }
  return null;
}

function formatOptionalConfigValue(value: string, emptyLabel = 'Not set'): string {
  const trimmed = value.trim();
  return trimmed || emptyLabel;
}

function formatAddressPreview(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Not set';
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
}

function formatUsdValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Not set';

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;
  return usdFormatter.format(normalizeDisplayNumber(parsed, 0));
}

function FieldTooltip({ label, description }: { label: string; description: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-arena-elements-textTertiary">{label}</span>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={`${label} info`}
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-arena-elements-textTertiary transition-colors hover:text-arena-elements-textSecondary"
          >
            <span className="i-ph:info text-xs" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={8}
            className="z-50 max-w-xs rounded-lg border border-arena-elements-borderColor/70 bg-arena-elements-background-depth-2 px-3 py-2 text-xs text-arena-elements-textSecondary shadow-xl"
          >
            {description}
            <Tooltip.Arrow className="fill-[var(--arena-elements-background-depth-2)]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </div>
  );
}

function InstructionValue({
  value,
  emptyLabel,
}: {
  value: string;
  emptyLabel: string;
}) {
  const trimmed = value.trim();

  if (!trimmed) {
    return (
      <div className="rounded-lg border border-dashed border-arena-elements-borderColor/70 bg-arena-elements-background-depth-1/70 px-3 py-2 text-sm text-arena-elements-textTertiary">
        <span className="inline-flex items-center gap-2">
          <span className="i-ph:sparkle text-xs" />
          {emptyLabel}
        </span>
      </div>
    );
  }

  return (
    <div className="text-sm whitespace-pre-wrap">
      {trimmed}
    </div>
  );
}

interface ControlsTabProps {
  bot: Bot;
  onConfigureSecrets?: () => void;
}

export function ControlsTab({ bot, onConfigureSecrets }: ControlsTabProps) {
  const { address } = useAccount();
  const operatorAuth = useOperatorAuth(bot.operatorApiUrl ?? '');
  const { data: detail, isLoading: detailLoading } = useBotDetail(bot.id, bot.operatorApiUrl, bot.operatorKind);
  const liveSummary = useBotLiveSummary({
    botId: bot.id,
    botName: bot.name,
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    chainId: bot.chainId,
  });
  const { startBot, stopBot, runNow, updateConfig, isAuthenticated, authenticate } = useBotControl(
    bot.id,
    bot.operatorApiUrl,
    bot.operatorKind,
  );
  const { service, remainingSeconds: serviceRemainingSeconds } = useServiceInfo(bot.serviceId || undefined);

  const ownerAddress = address ?? operatorAuth.accountAddress;
  const isOwner = detail?.submitter_address
    && ownerAddress
    && detail.submitter_address.toLowerCase() === ownerAddress.toLowerCase();

  if (detailLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (bot.verificationState === 'unverified') {
    return (
      <OperatorAccessCard
        title="Controls unavailable"
        description="This bot is still using unverified fallback data, so runtime controls stay disabled until the operator confirms the current state."
        apiUrl={bot.operatorApiUrl ?? ''}
      />
    );
  }

  if (!isAuthenticated && !detail) {
    return (
      <OperatorAccessCard
        description="Connect your wallet to load operator-managed bot controls."
        apiUrl={bot.operatorApiUrl ?? ''}
      />
    );
  }

  if (!detail) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:gear text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        Bot detail not available from operator API.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {!isOwner && detail.submitter_address && (
        <div className="lg:col-span-2 flex items-start gap-3 rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-2 px-4 py-3">
          <div className="i-ph:eye text-lg mt-0.5 text-arena-elements-textTertiary" />
          <div className="text-sm text-arena-elements-textSecondary">
            <span className="font-medium text-arena-elements-textPrimary">View-only.</span>{' '}
            This bot belongs to{' '}
            <span className="font-data text-arena-elements-textPrimary">
              {`${detail.submitter_address.slice(0, 6)}…${detail.submitter_address.slice(-4)}`}
            </span>
            . Connect that wallet to start/stop, run, or change its strategy.
          </div>
        </div>
      )}
      <StatusCard
        bot={bot}
        detail={detail}
        isOwner={!!isOwner}
        isAuthenticated={isAuthenticated}
        authenticate={authenticate}
        startBot={startBot}
        stopBot={stopBot}
        runNow={runNow}
        onConfigureSecrets={onConfigureSecrets}
      />
      {isOwner && (
        <ProvisionedSettingsCard detail={detail} />
      )}
      {isOwner && (
        <StrategyCard
          detail={detail}
          updateConfig={updateConfig}
        />
      )}
      <ValidatorInfoCard bot={bot} detail={detail} avgValidatorScore={liveSummary.avgValidatorScore} />
      <LifetimeCard
        bot={bot}
        detail={detail}
        service={service}
        serviceRemainingSeconds={serviceRemainingSeconds}
      />
      {!!bot.serviceId && (
        <BinaryUpdatesPanel serviceId={bot.serviceId} blueprintId={service?.blueprintId} />
      )}
      {isOwner && (
        <AdvancedCard detail={detail} />
      )}
    </div>
  );
}

// ── Status & Control Card ────────────────────────────────────────────────

function StatusCard({
  bot,
  detail,
  isOwner,
  isAuthenticated,
  authenticate,
  startBot,
  stopBot,
  runNow,
  onConfigureSecrets,
}: {
  bot: Bot;
  detail: NonNullable<ReturnType<typeof useBotDetail>['data']>;
  isOwner: boolean;
  isAuthenticated: boolean;
  authenticate: () => Promise<string | null>;
  startBot: ReturnType<typeof useBotControl>['startBot'];
  stopBot: ReturnType<typeof useBotControl>['stopBot'];
  runNow: ReturnType<typeof useBotControl>['runNow'];
  onConfigureSecrets?: () => void;
}) {
  const lifecycleStatus = bot.status === 'paused' ? 'paused' : bot.status;
  const isWindingDown = detail.lifecycle_status === 'winding_down';
  const isAwaitingSecrets = detail.lifecycle_status === 'awaiting_secrets';
  const isArchived = detail.lifecycle_status === 'archived';
  const canControl = isOwner && detail.control_available && !isArchived;
  const isRunning = detail.lifecycle_status === 'active' || bot.status === 'paused';

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-bold text-lg">Status & Control</h3>
        <Badge variant={botStatusBadgeVariant(lifecycleStatus)}>
          <div className={`w-1.5 h-1.5 rounded-full ${
            (lifecycleStatus === 'active' || lifecycleStatus === 'paused') && !isWindingDown
              ? 'bg-emerald-700 dark:bg-emerald-400 animate-glow-pulse'
              : 'bg-arena-elements-textTertiary'
          }`} />
          {botStatusLabel(lifecycleStatus)}
        </Badge>
      </div>

      {isArchived && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-arena-elements-background-depth-3 border border-arena-elements-borderColor/50 text-sm text-arena-elements-textSecondary">
          This bot is archived. Historical data remains available, but runtime controls are disabled.
        </div>
      )}

      {isWindingDown && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
          <span className="i-ph:warning text-xs mr-1" />
          Wind-down started {formatTimestamp(detail.wind_down_started_at!)}. Bot is liquidating positions.
        </div>
      )}

      {isAwaitingSecrets && isOwner && (
        <div className="mb-4 px-3 py-2.5 rounded-lg bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 text-sm text-violet-800 dark:text-violet-200 flex items-center gap-2">
          <span className="i-ph:key text-xs shrink-0" />
          <span className="flex-1">Configure API secrets to activate this bot.</span>
          {onConfigureSecrets && (
            <Button size="sm" onClick={onConfigureSecrets} className="text-xs h-7 px-3 shrink-0">
              Configure
            </Button>
          )}
        </div>
      )}

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Paper Trading</span>
          <span className="font-data">{detail.paper_trade ? 'Yes' : 'No'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Workflow</span>
          <span className="font-data">{detail.workflow_id ?? 'None'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Sandbox</span>
          <span className="font-data text-xs">
            {detail.sandbox_id}
          </span>
        </div>
      </div>

      {isOwner && (
        <div className="mt-5 flex flex-wrap gap-2">
          {!isAuthenticated ? (
            <Button size="sm" onClick={() => authenticate()}>
              <span className="i-ph:wallet text-xs mr-1" />
              Connect Wallet
            </Button>
          ) : (
            <>
              {isRunning ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!canControl || stopBot.isPending}
                  onClick={() => stopBot.mutate()}
                >
                  {stopBot.isPending ? (
                    <span className="i-ph:arrow-clockwise text-xs animate-spin mr-1" />
                  ) : (
                    <span className="i-ph:stop text-xs mr-1" />
                  )}
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={!canControl || startBot.isPending}
                  onClick={() => startBot.mutate()}
                >
                  {startBot.isPending ? (
                    <span className="i-ph:arrow-clockwise text-xs animate-spin mr-1" />
                  ) : (
                    <span className="i-ph:play text-xs mr-1" />
                  )}
                  Start
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={!canControl || !isRunning || runNow.isPending}
                onClick={() => runNow.mutate()}
              >
                {runNow.isPending ? (
                  <span className="i-ph:arrow-clockwise text-xs animate-spin mr-1" />
                ) : (
                  <span className="i-ph:lightning text-xs mr-1" />
                )}
                Run Now
              </Button>
            </>
          )}
        </div>
      )}

      {startBot.error && (
        <p className="mt-2 text-xs text-crimson-500">{(startBot.error as Error).message}</p>
      )}
      {stopBot.error && (
        <p className="mt-2 text-xs text-crimson-500">{(stopBot.error as Error).message}</p>
      )}
      {runNow.error && (
        <p className="mt-2 text-xs text-crimson-500">{(runNow.error as Error).message}</p>
      )}
      {runNow.isSuccess && (
        <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">Workflow executed successfully.</p>
      )}
    </div>
  );
}

// ── Lifetime & TTL Card ──────────────────────────────────────────────────

function LifetimeCard({
  bot,
  detail,
  service,
  serviceRemainingSeconds,
}: {
  bot: Bot;
  detail: NonNullable<ReturnType<typeof useBotDetail>['data']>;
  service: ReturnType<typeof useServiceInfo>['service'];
  serviceRemainingSeconds: number | null;
}) {
  const [extendDays, setExtendDays] = useState(7);
  const [showExtend, setShowExtend] = useState(false);
  const { writeContract, isPending: isExtending } = useWriteContract();

  const maxDays = detail.max_lifetime_days || 30;
  const createdAt = detail.created_at;
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsedDays = Math.floor((nowSec - createdAt) / 86400);
  const remainingDays = Math.max(0, maxDays - elapsedDays);
  const progressPct = Math.min(100, (elapsedDays / maxDays) * 100);

  const handleExtend = () => {
    if (!detail.sandbox_id || !bot.serviceId) return;
    const inputs = encodeAbiParameters(
      parseAbiParameters('string, uint64'),
      [detail.sandbox_id, BigInt(extendDays)],
    );
    writeContract(
      {
        address: addresses.tangle,
        abi: tangleJobsAbi,
        functionName: 'submitJob',
        args: [BigInt(bot.serviceId), JOB_EXTEND, inputs],
      },
      {
        onSuccess: () => {
          toast.success(`Bot lifetime extension submitted for ${extendDays} day${extendDays === 1 ? '' : 's'}.`);
        },
        onError: (err) => {
          const msg = err.message || 'Unknown error';
          toast.error(`Bot lifetime extension failed: ${msg.slice(0, 120)}`);
        },
      },
    );
  };

  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="font-display font-bold text-lg mb-4">Lifetime & TTL</h3>

      {/* Bot TTL */}
      <div className="mb-5">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-arena-elements-textTertiary">Bot Lifetime</span>
          <span className="font-data">
            {remainingDays}d remaining of {maxDays}d
          </span>
        </div>
        <div className="w-full h-2 rounded-full bg-arena-elements-borderColor/30 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              remainingDays <= 3 ? 'bg-crimson-500' : remainingDays <= 7 ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-arena-elements-textTertiary mt-1">
          <span>Created {formatTimestamp(createdAt)}</span>
          <span>Expires ~{formatTimestamp(createdAt + maxDays * 86400)}</span>
        </div>

        {detail.wind_down_started_at != null && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
            <span className="i-ph:warning text-xs mr-1" />
            Wind-down started — positions being liquidated.
          </div>
        )}

        {!showExtend ? (
          <Button size="sm" variant="outline" className="mt-3" onClick={() => setShowExtend(true)}>
            <span className="i-ph:plus text-xs mr-1" />
            Extend
          </Button>
        ) : (
          <div className="mt-3 p-3 rounded-lg bg-arena-elements-background-depth-2 space-y-3">
            <div className="flex items-center gap-3">
              <label htmlFor="extend-days" className="text-sm text-arena-elements-textSecondary whitespace-nowrap">
                Additional days
              </label>
              <input
                id="extend-days"
                type="number"
                min={1}
                max={365}
                value={extendDays}
                onChange={(e) => setExtendDays(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-20 px-2 py-1 rounded border border-arena-elements-borderColor bg-transparent text-sm font-data"
              />
            </div>
            <p className="text-xs text-arena-elements-textTertiary">
              Covered by service subscription
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={isExtending} onClick={handleExtend}>
                {isExtending ? 'Extending...' : 'Submit Extension'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowExtend(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Service TTL */}
      <div className="pt-4 border-t border-arena-elements-borderColor/30">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-arena-elements-textTertiary">Service TTL</span>
          {service ? (
            <span className="font-data">
              {serviceRemainingSeconds != null ? formatDuration(serviceRemainingSeconds) : 'Unknown'}
            </span>
          ) : (
            <span className="font-data text-arena-elements-textTertiary">N/A</span>
          )}
        </div>
        {service && (
          <div className="space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-arena-elements-textTertiary">Owner</span>
              <span className="font-data text-arena-elements-textTertiary">{service.owner.slice(0, 6)}...{service.owner.slice(-4)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-arena-elements-textTertiary">TTL (blocks)</span>
              <span className="font-data text-arena-elements-textTertiary">{service.ttl.toLocaleString()}</span>
            </div>
            <p className="text-xs text-arena-elements-textTertiary italic">
              Service TTL is set at creation and cannot be extended on-chain yet.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Strategy Configuration Card ──────────────────────────────────────────

function StrategyCard({
  detail,
  updateConfig,
}: {
  detail: NonNullable<ReturnType<typeof useBotDetail>['data']>;
  updateConfig: ReturnType<typeof useBotControl>['updateConfig'];
}) {
  const strategyConfig = detail.strategy_config ?? {};
  const riskParams = detail.risk_params ?? {};
  const savedExpertKnowledge = readConfigString(strategyConfig, 'expert_knowledge_override');
  const savedCustomInstructions = readConfigString(strategyConfig, 'custom_instructions');
  const savedMinAaveHealthFactor = readRiskNumber(riskParams, 'min_aave_health_factor', '1.5');
  const showAaveHealthFactor = detail.strategy_type === 'yield';
  const showPositionSizing = detail.strategy_type === 'hyperliquid_perp';
  const savedPositionSizePct = readPositionSizePct(strategyConfig);

  const [paperTrade, setPaperTrade] = useState(detail.paper_trade);
  const [minAaveHealthFactor, setMinAaveHealthFactor] = useState(savedMinAaveHealthFactor);
  const [positionSizePct, setPositionSizePct] = useState(savedPositionSizePct);
  const [expertKnowledgeOverride, setExpertKnowledgeOverride] = useState(savedExpertKnowledge);
  const [customInstructions, setCustomInstructions] = useState(savedCustomInstructions);
  const [draftExpertKnowledge, setDraftExpertKnowledge] = useState(savedExpertKnowledge);
  const [draftCustomInstructions, setDraftCustomInstructions] = useState(savedCustomInstructions);
  const [isInstructionsModalOpen, setIsInstructionsModalOpen] = useState(false);

  useEffect(() => {
    setPaperTrade(detail.paper_trade);
    setMinAaveHealthFactor(savedMinAaveHealthFactor);
    setPositionSizePct(savedPositionSizePct);
    setExpertKnowledgeOverride(savedExpertKnowledge);
    setCustomInstructions(savedCustomInstructions);
    setDraftExpertKnowledge(savedExpertKnowledge);
    setDraftCustomInstructions(savedCustomInstructions);
    setIsInstructionsModalOpen(false);
  }, [detail.id, detail.paper_trade, savedCustomInstructions, savedExpertKnowledge, savedMinAaveHealthFactor, savedPositionSizePct]);

  const hasUnsavedChanges = paperTrade !== detail.paper_trade
    || minAaveHealthFactor !== savedMinAaveHealthFactor
    || positionSizePct !== savedPositionSizePct
    || expertKnowledgeOverride !== savedExpertKnowledge
    || customInstructions !== savedCustomInstructions;

  const parsedMinAaveHealthFactor = Number(minAaveHealthFactor);
  const minAaveHealthFactorInvalid = showAaveHealthFactor
    && (!Number.isFinite(parsedMinAaveHealthFactor) || parsedMinAaveHealthFactor < 1.01);
  const positionSizeError = showPositionSizing ? validatePositionSizePct(positionSizePct) : null;

  const handlePaperTradeChange = (nextValue: boolean) => {
    if (!nextValue) {
      const confirmed = window.confirm(
        'Switch this bot to live trading mode? Future trades may execute on-chain.',
      );
      if (!confirmed) return;
    }
    setPaperTrade(nextValue);
  };

  const openInstructionsModal = () => {
    setDraftExpertKnowledge(expertKnowledgeOverride);
    setDraftCustomInstructions(customInstructions);
    setIsInstructionsModalOpen(true);
  };

  const closeInstructionsModal = () => {
    setDraftExpertKnowledge(expertKnowledgeOverride);
    setDraftCustomInstructions(customInstructions);
    setIsInstructionsModalOpen(false);
  };

  const applyInstructionDrafts = () => {
    setExpertKnowledgeOverride(draftExpertKnowledge);
    setCustomInstructions(draftCustomInstructions);
    setIsInstructionsModalOpen(false);
  };

  const handleSave = () => {
    if (minAaveHealthFactorInvalid) {
      toast.error('Aave health factor must be at least 1.01');
      return;
    }
    if (positionSizeError) {
      toast.error(positionSizeError);
      return;
    }
    const nextStrategyConfig: Record<string, unknown> = { ...strategyConfig };
    const nextRiskParams: Record<string, unknown> = { ...riskParams };

    nextStrategyConfig.paper_trade = paperTrade;
    if (showAaveHealthFactor) {
      nextRiskParams.min_aave_health_factor = parsedMinAaveHealthFactor;
    }
    if (showPositionSizing) {
      const pct = Number(positionSizePct);
      if (pct === Number(DEFAULT_POSITION_SIZE_PCT)) {
        delete nextStrategyConfig.position_sizing;
      } else {
        nextStrategyConfig.position_sizing = {
          method: 'fixed_fraction',
          fraction: pct / 100,
        };
      }
    }

    const trimmedExpertKnowledge = expertKnowledgeOverride.trim();
    if (trimmedExpertKnowledge) {
      nextStrategyConfig.expert_knowledge_override = trimmedExpertKnowledge;
    } else {
      delete nextStrategyConfig.expert_knowledge_override;
    }

    const trimmedCustomInstructions = customInstructions.trim();
    if (trimmedCustomInstructions) {
      nextStrategyConfig.custom_instructions = trimmedCustomInstructions;
    } else {
      delete nextStrategyConfig.custom_instructions;
    }

    updateConfig.mutate({
      strategyConfigJson: JSON.stringify(nextStrategyConfig),
      riskParamsJson: JSON.stringify(nextRiskParams),
    });
  };

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="mb-4">
        <h3 className="font-display font-bold text-lg">Strategy Configuration</h3>
      </div>

      <Tooltip.Provider delayDuration={150}>
        <div className="space-y-5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <FieldTooltip
              label="Trading Mode"
              description="Controls whether the bot simulates trades or executes them on-chain."
            />
            <div className="flex items-center gap-3">
              <span className={`text-xs font-medium ${paperTrade ? 'text-arena-elements-textTertiary' : 'text-arena-elements-textSecondary'}`}>
                Live
              </span>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  aria-label="Paper trading"
                  checked={paperTrade}
                  className="peer sr-only"
                  onChange={(e) => handlePaperTradeChange(e.target.checked)}
                  type="checkbox"
                />
                <span className="h-6 w-11 rounded-full bg-arena-elements-borderColor/80 transition-colors peer-checked:bg-violet-500" />
                <span className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
              </label>
              <span className={`text-xs font-medium ${paperTrade ? 'text-arena-elements-textSecondary' : 'text-arena-elements-textTertiary'}`}>
                Paper
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-arena-elements-textTertiary">
              {paperTrade
                ? 'Paper mode validates and simulates trades without on-chain execution.'
                : 'Live mode may execute trades on-chain using the bot vault.'}
            </span>
            <Badge variant={paperTrade ? 'outline' : 'accent'}>
              {paperTrade ? 'Paper' : 'Live'}
            </Badge>
          </div>

          {showAaveHealthFactor && (
            <div className="flex items-center justify-between gap-4">
              <FieldTooltip
                label="Aave Health Factor"
                description="Minimum Aave health factor required after live borrow or withdraw actions."
              />
              <input
                aria-label="Minimum Aave health factor"
                type="number"
                min="1.01"
                step="0.01"
                value={minAaveHealthFactor}
                onChange={(e) => setMinAaveHealthFactor(e.target.value)}
                className="h-9 w-28 rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-3 text-right font-data text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/60"
              />
            </div>
          )}

          {minAaveHealthFactorInvalid && (
            <p className="text-xs text-crimson-500">
              Minimum Aave health factor must be at least 1.01.
            </p>
          )}

          {showPositionSizing && (
            <div className="flex items-center justify-between gap-4">
              <FieldTooltip
                label="Max Position Size"
                description="Caps each new Hyperliquid perp entry as a percentage of the bot's total vault value."
              />
              <div className="flex items-center gap-2">
                <input
                  aria-label="Max position size"
                  type="number"
                  min={MIN_POSITION_SIZE_PCT}
                  max={MAX_POSITION_SIZE_PCT}
                  step="0.5"
                  value={positionSizePct}
                  onChange={(e) => setPositionSizePct(e.target.value)}
                  className="h-9 w-24 rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-3 text-right font-data text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/60"
                />
                <span className="text-xs font-data text-arena-elements-textTertiary">%</span>
              </div>
            </div>
          )}

          {positionSizeError && (
            <p className="text-xs text-crimson-500">
              {positionSizeError}.
            </p>
          )}

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-3">
              <FieldTooltip
                label="Bot Instructions"
                description="Fine-tune the bot's strategy context and behavior without editing raw JSON."
              />

              <div>
                <span className="block text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
                  Expert Knowledge
                </span>
                <InstructionValue
                  value={expertKnowledgeOverride}
                  emptyLabel="No extra domain guidance yet."
                />
              </div>

              <div>
                <span className="block text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
                  Custom Instructions
                </span>
                <InstructionValue
                  value={customInstructions}
                  emptyLabel="No custom behavior instructions yet."
                />
              </div>
            </div>

            <Button size="sm" variant="ghost" onClick={openInstructionsModal}>
              <span className="i-ph:pencil text-xs mr-1" />
              Edit
            </Button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-arena-elements-textTertiary">
              {hasUnsavedChanges ? 'You have unsaved configuration changes.' : 'No unsaved changes.'}
            </p>
            <Button size="sm" disabled={!hasUnsavedChanges || updateConfig.isPending || minAaveHealthFactorInvalid || Boolean(positionSizeError)} onClick={handleSave}>
              {updateConfig.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>

          {updateConfig.error && (
            <p className="text-xs text-crimson-500">{(updateConfig.error as Error).message}</p>
          )}
        </div>
      </Tooltip.Provider>

      <Dialog open={isInstructionsModalOpen} onOpenChange={(open: boolean) => !open && closeInstructionsModal()}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col overflow-hidden border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2 dark:bg-arena-elements-background-depth-4 shadow-2xl">
          <DialogHeader>
            <DialogTitle>Edit Bot Instructions</DialogTitle>
            <DialogDescription>
              Update the guidance that shapes how this bot reasons about markets and trading behavior.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-1 py-1">
            <div className="space-y-4 pb-1">
              <div>
                <label
                  htmlFor="expert-knowledge-override"
                  className="block text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1"
                >
                  Expert Knowledge
                </label>
                <textarea
                  id="expert-knowledge-override"
                  value={draftExpertKnowledge}
                  onChange={(e) => setDraftExpertKnowledge(e.target.value)}
                  rows={5}
                  className="w-full min-w-0 px-3 py-2 rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 text-sm resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/60"
                  placeholder="Add domain context or market expertise you want the bot to prioritize."
                />
              </div>

              <div>
                <label
                  htmlFor="custom-instructions"
                  className="block text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1"
                >
                  Custom Instructions
                </label>
                <textarea
                  id="custom-instructions"
                  value={draftCustomInstructions}
                  onChange={(e) => setDraftCustomInstructions(e.target.value)}
                  rows={5}
                  className="w-full min-w-0 px-3 py-2 rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 text-sm resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/60"
                  placeholder="Add plain-English rules, preferences, or operating guidance for this bot."
                />
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-arena-elements-borderColor/40 pt-4">
            <p className="text-xs text-arena-elements-textTertiary">
              Changes apply after you save from the Strategy Configuration card.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={closeInstructionsModal}>
                Cancel
              </Button>
              <Button size="sm" onClick={applyInstructionDrafts}>
                Done
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProvisionedSettingsCard({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof useBotDetail>['data']>;
}) {
  const strategyConfig = detail.strategy_config ?? {};
  const runtimeBackend = readConfigString(strategyConfig, 'runtime_backend');
  const assetToken = readConfigString(strategyConfig, 'asset_token');
  const initialCapitalUsd = readConfigString(strategyConfig, 'initial_capital_usd');
  const assetDisplay = assetToken ? resolveAssetDisplay(assetToken, detail.chain_id) : null;
  const assetUniverse = strategyConfig.asset_universe as
    | { allowed_assets?: { symbol?: string; address?: string }[]; base_asset?: string }
    | undefined;
  const allowedAssets = assetUniverse?.allowed_assets ?? [];

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="mb-4">
        <h3 className="font-display font-bold text-lg">Provisioned Settings</h3>
      </div>

      <p className="text-sm text-arena-elements-textTertiary">
        Deployment-time settings shown here for reference.
      </p>

      <div className="mt-4 space-y-3 text-sm">
        <div className="flex justify-between gap-4">
          <span className="text-arena-elements-textTertiary">Type</span>
          <span className="font-data">{detail.strategy_type}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-arena-elements-textTertiary">Runtime</span>
          <span className="font-data">{formatOptionalConfigValue(runtimeBackend)}</span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <span className="text-arena-elements-textTertiary">Asset Token</span>
          {assetDisplay ? (
            <AssetDisplay
              asset={assetDisplay}
              className="max-w-[220px] justify-end text-right"
              showSecondary
            />
          ) : (
            <span className="font-data text-xs">{formatAddressPreview(assetToken)}</span>
          )}
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-arena-elements-textTertiary">Initial Capital</span>
          <span className="font-data">{formatUsdValue(initialCapitalUsd)}</span>
        </div>
        {allowedAssets.length > 0 && (
          <div className="flex items-start justify-between gap-4">
            <span className="text-arena-elements-textTertiary">Asset Universe</span>
            <div className="flex max-w-[240px] flex-wrap justify-end gap-1.5">
              {allowedAssets.map((asset) => (
                <span
                  key={asset.address ?? asset.symbol}
                  className="rounded-md border border-arena-elements-borderColor/70 px-2 py-1 text-xs font-data"
                  title={asset.address}
                >
                  {asset.symbol ?? formatAddressPreview(asset.address ?? '')}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Validator Info Card ──────────────────────────────────────────────────

function ValidatorInfoCard({
  bot,
  detail,
  avgValidatorScore,
}: {
  bot: Bot;
  detail: NonNullable<ReturnType<typeof useBotDetail>['data']>;
  avgValidatorScore: number | null;
}) {
  const { data: trades } = useBotTrades(bot.id, bot.name, 50, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
  });

  const stats = useMemo(() => {
    if (!trades || trades.length === 0) return { approvalRate: null, totalValidated: 0 };
    const measured = trades.filter((trade) => {
      const display = getTradeValidationDisplay(trade);
      return display != null && display.state !== 'paper_bypassed';
    });
    const approved = measured.filter(
      (trade) => getTradeValidationDisplay(trade)?.state === 'approved_signed',
    );
    return {
      approvalRate: measured.length > 0 ? Math.round((approved.length / measured.length) * 100) : null,
      totalValidated: measured.length,
    };
  }, [trades]);

  const endpoints = detail.validator_endpoints ?? [];
  const serviceIds = detail.validator_service_ids ?? [];
  const hasValidators = endpoints.length > 0 || serviceIds.length > 0;

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-bold text-lg">Validation</h3>
        <div className="i-ph:shield-check text-lg text-violet-500" />
      </div>

      <div className="space-y-3 text-sm">
        {/* Service IDs */}
        <div className="flex justify-between items-start">
          <span className="text-arena-elements-textTertiary">Service IDs</span>
          <div className="flex gap-1 flex-wrap justify-end">
            {serviceIds.length > 0 ? serviceIds.map((id) => (
              <Badge key={id} variant="accent" className="text-xs py-0 font-data">{id}</Badge>
            )) : (
              <span className="font-data text-arena-elements-textTertiary">Default</span>
            )}
          </div>
        </div>

        {/* Endpoints */}
        <div className="flex justify-between items-start gap-4">
          <span className="text-arena-elements-textTertiary shrink-0">Endpoints</span>
          <div className="text-right">
            {endpoints.length > 0 ? endpoints.map((ep) => (
              <div key={ep} className="font-data text-xs text-arena-elements-textSecondary truncate max-w-[220px]" title={ep}>
                {ep}
              </div>
            )) : (
              <span className="font-data text-xs text-arena-elements-textTertiary">None configured</span>
            )}
          </div>
        </div>

        {/* Validator count */}
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Active</span>
          <span className="font-data">
            {hasValidators ? (
              <>{endpoints.length} validator{endpoints.length !== 1 ? 's' : ''}</>
            ) : (
              <span className="text-arena-elements-textTertiary">—</span>
            )}
          </span>
        </div>

        {/* Avg Score */}
        <div className="flex justify-between items-center">
          <span className="text-arena-elements-textTertiary">Avg Score</span>
          {avgValidatorScore != null ? (
            <ScoreRing score={avgValidatorScore} size={32} />
          ) : (
            <span className="font-data text-arena-elements-textTertiary">—</span>
          )}
        </div>

        {/* Approval Rate */}
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Approval Rate</span>
          <span className="font-data">
            {stats.approvalRate != null ? (
              <span className={stats.approvalRate >= 80 ? 'text-arena-elements-icon-success' : stats.approvalRate >= 50 ? 'text-amber-700 dark:text-amber-400' : 'text-arena-elements-icon-error'}>
                {stats.approvalRate}%
              </span>
            ) : (
              <span className="text-arena-elements-textTertiary">—</span>
            )}
            {stats.totalValidated > 0 && (
              <span className="text-arena-elements-textTertiary ml-1 text-xs">
                ({stats.totalValidated} trades)
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Paper trade note */}
      {detail.paper_trade && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-arena-elements-background-depth-2 text-xs text-arena-elements-textTertiary">
          <span className="i-ph:note text-xs mr-1" />
          Paper mode: validates trades but does not execute on-chain.
        </div>
      )}
    </div>
  );
}

// ── Advanced Card ────────────────────────────────────────────────────────

function AdvancedCard({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof useBotDetail>['data']>;
}) {
  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="font-display font-bold text-lg mb-4">Advanced</h3>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Bot ID</span>
          <span className="font-data text-xs">{detail.id}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Chain ID</span>
          <span className="font-data">{detail.chain_id}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Vault</span>
          <span className="font-data text-xs">{detail.vault_address.slice(0, 10)}...{detail.vault_address.slice(-8)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Secrets</span>
          <Badge variant={detail.secrets_configured ? 'success' : 'outline'}>
            {detail.secrets_configured ? 'Configured' : 'Not Set'}
          </Badge>
        </div>
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Submitter</span>
          <span className="font-data text-xs">
            {detail.submitter_address
              ? `${detail.submitter_address.slice(0, 6)}...${detail.submitter_address.slice(-4)}`
              : 'N/A'}
          </span>
        </div>
      </div>

      <p className="mt-4 text-xs text-arena-elements-textTertiary italic">
        Deprovision available from the dashboard provision page.
      </p>
    </div>
  );
}
