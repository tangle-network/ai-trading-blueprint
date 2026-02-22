import { useState, useMemo } from 'react';
import { useAccount, useWriteContract } from 'wagmi';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { useBotDetail } from '~/lib/hooks/useBotDetail';
import { useBotControl } from '~/lib/hooks/useBotControl';
import { useBotTrades } from '~/lib/hooks/useBotApi';
import { useServiceInfo } from '~/lib/hooks/useServiceInfo';
import { Badge, Button } from '@tangle/blueprint-ui/components';
import { ScoreRing } from './shared/ValidatorComponents';
import { tangleJobsAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';

const JOB_EXTEND = 6;

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

interface ControlsTabProps {
  bot: Bot;
  onConfigureSecrets?: () => void;
}

export function ControlsTab({ bot, onConfigureSecrets }: ControlsTabProps) {
  const { address } = useAccount();
  const { data: detail, isLoading: detailLoading } = useBotDetail(bot.id);
  const { startBot, stopBot, runNow, updateConfig, isAuthenticated, authenticate } = useBotControl(bot.id);
  const { service, remainingSeconds: serviceRemainingSeconds } = useServiceInfo(bot.serviceId || undefined);

  const isOwner = detail?.submitter_address
    && address
    && detail.submitter_address.toLowerCase() === address.toLowerCase();

  if (detailLoading) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading controls...
      </div>
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
      <StatusCard
        detail={detail}
        isOwner={!!isOwner}
        isAuthenticated={isAuthenticated}
        authenticate={authenticate}
        startBot={startBot}
        stopBot={stopBot}
        runNow={runNow}
        onConfigureSecrets={onConfigureSecrets}
      />
      <ValidatorInfoCard bot={bot} detail={detail} />
      <LifetimeCard
        bot={bot}
        detail={detail}
        service={service}
        serviceRemainingSeconds={serviceRemainingSeconds}
      />
      {isOwner && (
        <StrategyCard
          detail={detail}
          updateConfig={updateConfig}
        />
      )}
      {isOwner && (
        <AdvancedCard detail={detail} />
      )}
    </div>
  );
}

// ── Status & Control Card ────────────────────────────────────────────────

function StatusCard({
  detail,
  isOwner,
  isAuthenticated,
  authenticate,
  startBot,
  stopBot,
  runNow,
  onConfigureSecrets,
}: {
  detail: NonNullable<ReturnType<typeof useBotDetail>['data']>;
  isOwner: boolean;
  isAuthenticated: boolean;
  authenticate: () => Promise<string | null>;
  startBot: ReturnType<typeof useBotControl>['startBot'];
  stopBot: ReturnType<typeof useBotControl>['stopBot'];
  runNow: ReturnType<typeof useBotControl>['runNow'];
  onConfigureSecrets?: () => void;
}) {
  const isWindingDown = detail.wind_down_started_at != null;
  const isAwaitingSecrets = !detail.secrets_configured;

  const statusVariant = isWindingDown
    ? 'amber'
    : isAwaitingSecrets
      ? 'outline'
      : detail.trading_active
        ? 'success'
        : 'destructive';

  const statusLabel = isWindingDown
    ? 'Winding Down'
    : isAwaitingSecrets
      ? 'Awaiting Secrets'
      : detail.trading_active
        ? 'Active'
        : 'Stopped';

  const canControl = isOwner && !isWindingDown && !isAwaitingSecrets;

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-bold text-lg">Status & Control</h3>
        <Badge variant={statusVariant as 'success' | 'amber' | 'destructive' | 'outline'}>
          <div className={`w-1.5 h-1.5 rounded-full ${
            detail.trading_active && !isWindingDown ? 'bg-emerald-700 dark:bg-emerald-400 animate-glow-pulse' : 'bg-arena-elements-textTertiary'
          }`} />
          {statusLabel}
        </Badge>
      </div>

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
          <span className="font-data text-xs">{detail.sandbox_id.slice(0, 16)}...</span>
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
              {detail.trading_active ? (
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
                disabled={!canControl || !detail.trading_active || runNow.isPending}
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
    writeContract({
      address: addresses.tangle,
      abi: tangleJobsAbi,
      functionName: 'submitJob',
      args: [BigInt(bot.serviceId), JOB_EXTEND, inputs],
    });
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
          <div className="space-y-1 text-xs text-arena-elements-textTertiary">
            <div className="flex justify-between">
              <span>Owner</span>
              <span className="font-data">{service.owner.slice(0, 6)}...{service.owner.slice(-4)}</span>
            </div>
            <div className="flex justify-between">
              <span>TTL (blocks)</span>
              <span className="font-data">{service.ttl.toLocaleString()}</span>
            </div>
            <p className="mt-2 italic">
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
  const [editing, setEditing] = useState(false);
  const [strategyJson, setStrategyJson] = useState(() =>
    JSON.stringify(detail.strategy_config, null, 2),
  );
  const [riskJson, setRiskJson] = useState(() =>
    JSON.stringify(detail.risk_params, null, 2),
  );

  const handleSave = () => {
    updateConfig.mutate(
      { strategyConfigJson: strategyJson, riskParamsJson: riskJson },
      {
        onSuccess: () => setEditing(false),
      },
    );
  };

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-bold text-lg">Strategy Configuration</h3>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <span className="i-ph:pencil text-xs mr-1" />
            Edit
          </Button>
        )}
      </div>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-arena-elements-textTertiary">Type</span>
          <span className="font-data">{detail.strategy_type}</span>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="strategy-config" className="block text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
              Strategy Config
            </label>
            <textarea
              id="strategy-config"
              value={strategyJson}
              onChange={(e) => setStrategyJson(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 rounded-lg border border-arena-elements-borderColor bg-transparent text-sm font-mono resize-y"
            />
          </div>
          <div>
            <label htmlFor="risk-params" className="block text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
              Risk Params
            </label>
            <textarea
              id="risk-params"
              value={riskJson}
              onChange={(e) => setRiskJson(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-arena-elements-borderColor bg-transparent text-sm font-mono resize-y"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={updateConfig.isPending} onClick={handleSave}>
              {updateConfig.isPending ? 'Saving...' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {updateConfig.error && (
            <p className="text-xs text-crimson-500">{(updateConfig.error as Error).message}</p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <span className="block text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
              Strategy Config
            </span>
            <pre className="text-xs font-mono bg-arena-elements-background-depth-2 rounded-lg p-3 overflow-x-auto max-h-40">
              {JSON.stringify(detail.strategy_config, null, 2)}
            </pre>
          </div>
          <div>
            <span className="block text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1">
              Risk Params
            </span>
            <pre className="text-xs font-mono bg-arena-elements-background-depth-2 rounded-lg p-3 overflow-x-auto max-h-40">
              {JSON.stringify(detail.risk_params, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Validator Info Card ──────────────────────────────────────────────────

function ValidatorInfoCard({
  bot,
  detail,
}: {
  bot: Bot;
  detail: NonNullable<ReturnType<typeof useBotDetail>['data']>;
}) {
  const { data: trades } = useBotTrades(bot.id, bot.name);

  const stats = useMemo(() => {
    if (!trades || trades.length === 0) return { approvalRate: null, totalValidated: 0 };
    const validated = trades.filter((t) => t.validation);
    const approved = validated.filter((t) => t.validation?.approved);
    return {
      approvalRate: validated.length > 0 ? Math.round((approved.length / validated.length) * 100) : null,
      totalValidated: validated.length,
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
          {bot.avgValidatorScore > 0 ? (
            <ScoreRing score={bot.avgValidatorScore} size={32} />
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
