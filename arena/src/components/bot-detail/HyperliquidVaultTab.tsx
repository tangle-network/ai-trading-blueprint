import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { formatUnits, isAddress, parseUnits } from 'viem';
import type { Address } from 'viem';
import { toast } from 'sonner';
import { addTx } from '@tangle-network/blueprint-ui';
import { Button, Input } from '@tangle-network/blueprint-ui/components';
import type { Bot } from '~/lib/types/bot';
import { tradingVaultAbi } from '~/lib/contracts/abis';
import { getChainPublicClient } from '~/lib/contracts/chainClients';
import { networks } from '~/lib/contracts/chains';
import { useVaultRead } from '~/lib/hooks/useVaultRead';
import {
  useCancelRedeem,
  useFulfillNextRedeem,
  useRedeem,
  useRequestRedeem,
} from '~/lib/hooks/useVaultWrite';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { operatorJsonWithAuth } from '~/lib/operator/fetch';
import { OPERATOR_API_URL } from '~/lib/operator/meta';
import { formatNumber } from '~/lib/format';

interface HyperliquidVaultTabProps {
  bot: Bot;
}

interface HyperliquidNavSnapshot {
  bot_id: string;
  as_of: number;
  idle_usdc: string;
  hyperliquid_equity: string;
  withdrawable_usdc: string;
  total_nav: string;
  total_shares: string;
  share_price: string;
  margin_usage_bps: number;
  open_order_count: number;
  position_count: number;
  warnings: string[];
  onchain_accounting_tx_hash?: string | null;
}

interface HyperliquidNavResponse {
  snapshot: HyperliquidNavSnapshot;
  stale: boolean;
}

type HyperliquidBotMode = 'normal' | 'liquidity' | 'emergency_wind_down';

interface HyperliquidModeSnapshot {
  bot_id: string;
  mode: HyperliquidBotMode;
  reason: string;
  checked_at: string;
  thresholds: {
    liquidity_mode_queue_bps: number;
    emergency_queue_bps: number;
    min_idle_usdc_bps: number;
    max_margin_usage_bps: number;
  };
  metrics: {
    nav_as_of?: string | null;
    nav_stale: boolean;
    total_nav?: string | null;
    idle_usdc?: string | null;
    queued_withdrawal_shares?: string | null;
    accounting_share_supply?: string | null;
    queued_withdrawal_bps?: number | null;
    idle_usdc_bps?: number | null;
    margin_usage_bps?: number | null;
  };
}

interface HyperliquidModeResponse {
  snapshot: HyperliquidModeSnapshot;
}

interface HyperliquidAccountingState {
  idleAssets?: bigint;
  hyperliquidAssets?: bigint;
  pendingRedeemShares?: bigint;
  accountingShareSupply?: bigint;
  isAccountingFresh?: boolean;
  accountingUpdatedAt?: bigint;
  maxAccountingStaleness?: bigint;
  nextWithdrawalRequestId?: bigint;
  nextFulfillableWithdrawalRequestId?: bigint;
}

interface WithdrawalRequestView {
  id: bigint;
  owner: Address;
  receiver: Address;
  shares: bigint;
  createdAt: bigint;
  fulfilledAt: bigint;
  cancelledAt: bigint;
}

const HYPEREVM_TESTNET_CHAIN_ID = Number(import.meta.env.VITE_HYPEREVM_TESTNET_CHAIN_ID ?? 998);

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function formatUsd(value: string | number | undefined): string {
  if (value == null || value === '') return 'N/A';
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 'N/A';
  return usdFormatter.format(parsed);
}

function formatPercentBps(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A';
  return `${formatNumber(value / 100, { maximumFractionDigits: 2 })}%`;
}

function formatTimestamp(seconds: number | bigint | undefined): string {
  if (seconds == null) return 'N/A';
  const value = typeof seconds === 'bigint' ? Number(seconds) : seconds;
  if (!Number.isFinite(value) || value <= 0) return 'Never';
  return new Date(value * 1000).toLocaleString();
}

function formatIsoTimestamp(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function formatShares(value: bigint | undefined, decimals: number): string {
  if (value == null) return 'N/A';
  return formatNumber(Number(formatUnits(value, decimals)), { maximumFractionDigits: 6 });
}

function modeLabel(mode: HyperliquidBotMode | undefined): string {
  switch (mode) {
    case 'normal':
      return 'Normal';
    case 'liquidity':
      return 'Liquidity';
    case 'emergency_wind_down':
      return 'Emergency';
    default:
      return 'Unknown';
  }
}

function modeClassName(mode: HyperliquidBotMode | undefined): string {
  switch (mode) {
    case 'normal':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'liquidity':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'emergency_wind_down':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';
    default:
      return 'border-arena-elements-borderColor/70 bg-muted/20 text-muted-foreground';
  }
}

function requestStatus(request: WithdrawalRequestView): 'pending' | 'fulfilled' | 'cancelled' {
  if (request.cancelledAt > 0n) return 'cancelled';
  if (request.fulfilledAt > 0n) return 'fulfilled';
  return 'pending';
}

function readWithdrawalTuple(requestId: bigint, raw: unknown): WithdrawalRequestView {
  const tuple = raw as {
    0?: Address;
    1?: Address;
    2?: bigint;
    3?: bigint;
    4?: bigint;
    5?: bigint;
    owner?: Address;
    receiver?: Address;
    shares?: bigint;
    createdAt?: bigint;
    fulfilledAt?: bigint;
    cancelledAt?: bigint;
  };

  return {
    id: requestId,
    owner: tuple.owner ?? tuple[0] ?? '0x0000000000000000000000000000000000000000',
    receiver: tuple.receiver ?? tuple[1] ?? '0x0000000000000000000000000000000000000000',
    shares: tuple.shares ?? tuple[2] ?? 0n,
    createdAt: tuple.createdAt ?? tuple[3] ?? 0n,
    fulfilledAt: tuple.fulfilledAt ?? tuple[4] ?? 0n,
    cancelledAt: tuple.cancelledAt ?? tuple[5] ?? 0n,
  };
}

export function HyperliquidVaultTab({ bot }: HyperliquidVaultTabProps) {
  const { address: userAddress, chainId, isConnected } = useAccount();
  const apiUrl = bot.operatorApiUrl ?? OPERATOR_API_URL;
  const auth = useOperatorAuth(apiUrl);
  const targetChainId = bot.chainId ?? HYPEREVM_TESTNET_CHAIN_ID;
  const targetChainName = networks[targetChainId]?.label ?? networks[targetChainId]?.chain.name ?? `Chain ${targetChainId}`;
  const vaultAddress = isAddress(bot.vaultAddress) ? (bot.vaultAddress as Address) : undefined;
  const isReady = isConnected && chainId === targetChainId;
  const vault = useVaultRead(vaultAddress, targetChainId);
  const shareUnitDecimals = vault.assetDecimals;

  const navQuery = useQuery({
    queryKey: ['hyperliquid-nav', apiUrl, bot.id, auth.authCacheKey],
    enabled: bot.strategyType === 'hyperliquid_perp' && Boolean(auth.authCacheKey && auth.getCachedToken()),
    refetchInterval: 15_000,
    queryFn: () =>
      operatorJsonWithAuth<HyperliquidNavResponse>(
        apiUrl,
        `/api/bots/${encodeURIComponent(bot.id)}/hyperliquid/nav`,
        auth,
      ),
  });

  const modeQuery = useQuery({
    queryKey: ['hyperliquid-mode', apiUrl, bot.id, auth.authCacheKey],
    enabled: bot.strategyType === 'hyperliquid_perp' && Boolean(auth.authCacheKey && auth.getCachedToken()),
    refetchInterval: 15_000,
    queryFn: () =>
      operatorJsonWithAuth<HyperliquidModeResponse>(
        apiUrl,
        `/api/bots/${encodeURIComponent(bot.id)}/hyperliquid/mode`,
        auth,
      ),
  });

  const accountingQuery = useQuery({
    queryKey: ['hyperliquid-vault-accounting', vaultAddress, targetChainId],
    enabled: Boolean(vaultAddress),
    refetchInterval: 15_000,
    queryFn: async (): Promise<HyperliquidAccountingState> => {
      if (!vaultAddress) return {};
      const client = getChainPublicClient(targetChainId);
      const results = await client.multicall({
        contracts: [
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'idleAssets' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'hyperliquidAccountAssets' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'pendingRedeemShares' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'accountingShareSupply' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'isAccountingFresh' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'hyperliquidAccountAssetsUpdatedAt' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'maxAccountingStaleness' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'nextWithdrawalRequestId' },
          { address: vaultAddress, abi: tradingVaultAbi, functionName: 'nextFulfillableWithdrawalRequestId' },
        ],
        allowFailure: true,
      });

      return {
        idleAssets: results[0]?.status === 'success' ? (results[0].result as bigint) : undefined,
        hyperliquidAssets: results[1]?.status === 'success' ? (results[1].result as bigint) : undefined,
        pendingRedeemShares: results[2]?.status === 'success' ? (results[2].result as bigint) : undefined,
        accountingShareSupply: results[3]?.status === 'success' ? (results[3].result as bigint) : undefined,
        isAccountingFresh: results[4]?.status === 'success' ? (results[4].result as boolean) : undefined,
        accountingUpdatedAt: results[5]?.status === 'success' ? (results[5].result as bigint) : undefined,
        maxAccountingStaleness: results[6]?.status === 'success' ? (results[6].result as bigint) : undefined,
        nextWithdrawalRequestId: results[7]?.status === 'success' ? (results[7].result as bigint) : undefined,
        nextFulfillableWithdrawalRequestId: results[8]?.status === 'success' ? (results[8].result as bigint) : undefined,
      };
    },
  });

  const queueQuery = useQuery({
    queryKey: [
      'hyperliquid-withdrawal-queue',
      vaultAddress,
      targetChainId,
      userAddress?.toLowerCase(),
      accountingQuery.data?.nextWithdrawalRequestId?.toString(),
    ],
    enabled: Boolean(vaultAddress && userAddress && accountingQuery.data?.nextWithdrawalRequestId),
    refetchInterval: 15_000,
    queryFn: async (): Promise<WithdrawalRequestView[]> => {
      if (!vaultAddress || !userAddress) return [];
      const latest = accountingQuery.data?.nextWithdrawalRequestId ?? 0n;
      if (latest === 0n) return [];
      const first = latest > 100n ? latest - 99n : 1n;
      const client = getChainPublicClient(targetChainId);
      const ids: bigint[] = [];
      for (let id = first; id <= latest; id += 1n) {
        ids.push(id);
      }
      const results = await client.multicall({
        contracts: ids.map((id) => ({
          address: vaultAddress,
          abi: tradingVaultAbi,
          functionName: 'withdrawalRequests',
          args: [id],
        })),
        allowFailure: true,
      });

      return results
        .map((result, index) => (
          result.status === 'success'
            ? readWithdrawalTuple(ids[index] ?? 0n, result.result)
            : null
        ))
        .filter((request): request is WithdrawalRequestView => (
          request != null &&
          request.owner.toLowerCase() === userAddress.toLowerCase() &&
          request.shares > 0n
        ))
        .sort((a, b) => Number(b.id - a.id));
    },
  });

  const refetchVaultState = () => {
    void vault.refetch();
    void accountingQuery.refetch();
    void queueQuery.refetch();
    void navQuery.refetch();
    void modeQuery.refetch();
  };

  if (bot.strategyType !== 'hyperliquid_perp') {
    return (
      <section className="rounded-lg border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold">Hyperliquid vault</h3>
        <p className="text-sm text-muted-foreground">
          This tab is only available for Hyperliquid perp bots.
        </p>
      </section>
    );
  }

  if (!vaultAddress) {
    return (
      <section className="rounded-lg border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold">Hyperliquid vault</h3>
        <p className="text-sm text-red-500">This bot does not have a valid vault address.</p>
      </section>
    );
  }

  const snapshot = navQuery.data?.snapshot;
  const mode = modeQuery.data?.snapshot;
  const onchain = accountingQuery.data;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-card p-4">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold">Hyperliquid vault</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Share value includes idle vault USDC plus the bot&apos;s Hyperliquid account equity.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={navQuery.isFetching || modeQuery.isFetching}
            onClick={() => {
              void navQuery.refetch();
              void modeQuery.refetch();
            }}
          >
            {navQuery.isFetching || modeQuery.isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>

        {!auth.isAuthenticated && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            <div className="mb-2 font-medium">Operator authentication required</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={auth.isAuthenticating}
              onClick={() => void auth.authenticate()}
            >
              {auth.isAuthenticating ? 'Authenticating...' : 'Authenticate'}
            </Button>
          </div>
        )}

        {navQuery.error && (
          <p className="mb-4 text-sm text-red-500">
            NAV unavailable: {navQuery.error instanceof Error ? navQuery.error.message : String(navQuery.error)}
          </p>
        )}
        {modeQuery.error && (
          <p className="mb-4 text-sm text-red-500">
            Mode unavailable: {modeQuery.error instanceof Error ? modeQuery.error.message : String(modeQuery.error)}
          </p>
        )}

        <div className={`mb-4 rounded-lg border p-3 ${modeClassName(mode?.mode)}`}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase">Mode</div>
              <div className="mt-1 text-lg font-semibold">{modeLabel(mode?.mode)}</div>
            </div>
            <div className="text-xs sm:text-right">
              <div>Checked: {formatIsoTimestamp(mode?.checked_at)}</div>
              <div>NAV stale: {mode?.metrics.nav_stale == null ? 'N/A' : mode.metrics.nav_stale ? 'yes' : 'no'}</div>
            </div>
          </div>
          <p className="mt-2 text-sm">{mode?.reason ?? 'Mode has not been loaded yet.'}</p>
        </div>

        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Total NAV" value={formatUsd(snapshot?.total_nav ?? vault.tvl)} />
          <Metric label="Share price" value={formatUsd(snapshot?.share_price ?? vault.sharePrice)} />
          <Metric label="Idle USDC" value={snapshot ? formatUsd(snapshot.idle_usdc) : formatAsset(onchain?.idleAssets, vault.assetDecimals, vault.assetSymbol)} />
          <Metric label="Hyperliquid equity" value={snapshot ? formatUsd(snapshot.hyperliquid_equity) : formatAsset(onchain?.hyperliquidAssets, vault.assetDecimals, vault.assetSymbol)} />
          <Metric label="Withdrawable now" value={snapshot ? formatUsd(snapshot.withdrawable_usdc) : formatAsset(onchain?.idleAssets, vault.assetDecimals, vault.assetSymbol)} />
          <Metric label="Queued shares" value={formatShares(onchain?.pendingRedeemShares, shareUnitDecimals)} />
          <Metric label="Queued withdrawal %" value={formatPercentBps(mode?.metrics.queued_withdrawal_bps ?? undefined)} />
          <Metric label="Idle USDC %" value={formatPercentBps(mode?.metrics.idle_usdc_bps ?? undefined)} />
          <Metric label="Margin usage" value={formatPercentBps(mode?.metrics.margin_usage_bps ?? snapshot?.margin_usage_bps)} />
          <Metric label="Last accounting update" value={formatTimestamp(onchain?.accountingUpdatedAt)} />
        </dl>

        <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
          <div>Vault: <span className="font-mono break-all">{vaultAddress}</span></div>
          <div>Chain: {targetChainName}</div>
          <div>Accounting fresh: {onchain?.isAccountingFresh == null ? 'N/A' : onchain.isAccountingFresh ? 'yes' : 'no'}</div>
          <div>Max accounting staleness: {onchain?.maxAccountingStaleness == null ? 'N/A' : `${onchain.maxAccountingStaleness.toString()}s`}</div>
          <div>Liquidity mode threshold: {formatPercentBps(mode?.thresholds.liquidity_mode_queue_bps)}</div>
          <div>Emergency queue threshold: {formatPercentBps(mode?.thresholds.emergency_queue_bps)}</div>
        </div>

        {snapshot?.warnings?.length ? (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            {snapshot.warnings.join(' ')}
          </div>
        ) : null}
      </section>

      <RedeemPanel
        vaultAddress={vaultAddress}
        targetChainId={targetChainId}
        targetChainName={targetChainName}
        shareUnitDecimals={shareUnitDecimals}
        userShares={vault.userShares}
        paused={vault.paused}
        isReady={isReady}
        isConnected={isConnected}
        assetSymbol={vault.assetSymbol}
        idleUsdc={snapshot?.idle_usdc}
        sharePrice={snapshot?.share_price}
        accountingFresh={onchain?.isAccountingFresh}
        onSuccess={refetchVaultState}
      />

      <QueuePanel
        vaultAddress={vaultAddress}
        targetChainId={targetChainId}
        targetChainName={targetChainName}
        shareUnitDecimals={shareUnitDecimals}
        requests={queueQuery.data ?? []}
        isLoading={queueQuery.isLoading || accountingQuery.isLoading}
        isReady={isReady}
        nextFulfillableWithdrawalRequestId={onchain?.nextFulfillableWithdrawalRequestId}
        onSuccess={refetchVaultState}
      />
    </div>
  );
}

function RedeemPanel({
  vaultAddress,
  targetChainId,
  targetChainName,
  shareUnitDecimals,
  userShares,
  paused,
  isReady,
  isConnected,
  assetSymbol,
  idleUsdc,
  sharePrice,
  accountingFresh,
  onSuccess,
}: {
  vaultAddress: Address;
  targetChainId: number;
  targetChainName: string;
  shareUnitDecimals: number;
  userShares?: bigint;
  paused: boolean;
  isReady: boolean;
  isConnected: boolean;
  assetSymbol: string;
  idleUsdc?: string;
  sharePrice?: string;
  accountingFresh?: boolean;
  onSuccess: () => void;
}) {
  const [shares, setShares] = useState('');
  const redeem = useRedeem();
  const requestRedeem = useRequestRedeem();
  const confirmedRef = useRef(false);
  const queuedConfirmedRef = useRef(false);

  const parsedShares = useMemo(() => {
    if (!shares.trim()) return 0n;
    try {
      const parsed = parseUnits(shares, shareUnitDecimals);
      return parsed > 0n ? parsed : 0n;
    } catch {
      return null;
    }
  }, [shares, shareUnitDecimals]);

  const sharesNumber = Number(shares);
  const estimatedUsdc = Number.isFinite(sharesNumber) && sharesNumber > 0 && sharePrice
    ? sharesNumber * Number(sharePrice)
    : undefined;
  const instantLiquidity = idleUsdc ? Number(idleUsdc) : undefined;
  const willBeInstant =
    estimatedUsdc != null &&
    instantLiquidity != null &&
    estimatedUsdc > 0 &&
    estimatedUsdc <= instantLiquidity;
  const insufficientShares = typeof parsedShares === 'bigint' && parsedShares > 0n && (userShares ?? 0n) < parsedShares;
  const maxShares = userShares != null ? Number(formatUnits(userShares, shareUnitDecimals)) : undefined;
  const isPending = redeem.isPending || redeem.isConfirming || requestRedeem.isPending || requestRedeem.isConfirming;

  useEffect(() => {
    if (redeem.isSuccess && !confirmedRef.current) {
      confirmedRef.current = true;
      toast.success('Withdrawal confirmed');
      redeem.reset();
      setShares('');
      onSuccess();
    }
    if (!redeem.isSuccess) {
      confirmedRef.current = false;
    }
  }, [onSuccess, redeem]);

  useEffect(() => {
    if (requestRedeem.isSuccess && !queuedConfirmedRef.current) {
      queuedConfirmedRef.current = true;
      toast.success('Withdrawal request queued');
      requestRedeem.reset();
      setShares('');
      onSuccess();
    }
    if (!requestRedeem.isSuccess) {
      queuedConfirmedRef.current = false;
    }
  }, [onSuccess, requestRedeem]);

  const handleRedeem = () => {
    if (parsedShares === null || parsedShares === 0n || !Number.isFinite(sharesNumber) || sharesNumber <= 0) {
      toast.error('Enter a valid number of shares');
      return;
    }
    if (!isReady) {
      toast.error(`Switch to ${targetChainName} first`);
      return;
    }
    if (paused) {
      toast.error('Vault is paused');
      return;
    }
    if (accountingFresh === false) {
      toast.error('Vault accounting is stale');
      return;
    }
    if (insufficientShares) {
      toast.error('Insufficient shares');
      return;
    }

    const action = willBeInstant ? redeem.redeem : requestRedeem.requestRedeem;
    const label = willBeInstant ? 'Withdraw' : 'Queue withdrawal';
    action(vaultAddress, shares, shareUnitDecimals, targetChainId, {
      onHash(h) {
        addTx(h, `${label} ${shares || '?'} shares`, targetChainId);
      },
      onError(e) {
        toast.error(`${label} failed: ${e.message.slice(0, 100)}`);
        redeem.reset();
        requestRedeem.reset();
      },
    });
  };

  const buttonText = !isConnected
    ? 'Connect Wallet'
    : !isReady
    ? `Switch to ${targetChainName}`
    : paused
    ? 'Vault Paused'
    : parsedShares === null
    ? 'Invalid Shares'
    : insufficientShares
    ? 'Insufficient Shares'
    : isPending
    ? willBeInstant ? 'Withdrawing...' : 'Queueing...'
    : willBeInstant
    ? `Withdraw ${assetSymbol}`
    : 'Queue Withdrawal';

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">Redeem shares</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Instant redemption uses idle vault USDC. Larger exits are queued by shares and paid at fresh NAV when fulfilled.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <label htmlFor="hyperliquid-redeem-shares" className="text-xs font-semibold uppercase text-muted-foreground">
              Shares
            </label>
            {maxShares != null && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                disabled={isPending}
                onClick={() => setShares(String(maxShares))}
              >
                Balance: {formatNumber(maxShares, { maximumFractionDigits: 6 })}
              </button>
            )}
          </div>
          <Input
            id="hyperliquid-redeem-shares"
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={shares}
            disabled={isPending}
            onChange={(event) => setShares(event.target.value)}
          />
        </div>
        <div className="rounded-lg border bg-muted/20 p-3 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Estimated value</span>
            <span className="font-medium">{formatUsd(estimatedUsdc)}</span>
          </div>
          <div className="mt-2 flex justify-between gap-3">
            <span className="text-muted-foreground">Path</span>
            <span className="font-medium">{willBeInstant ? 'Instant' : 'Queued'}</span>
          </div>
        </div>
      </div>
      <Button
        type="button"
        className="mt-4 w-full sm:w-auto"
        variant="outline"
        disabled={!isReady || paused || isPending || parsedShares === null || parsedShares === 0n || insufficientShares}
        onClick={handleRedeem}
      >
        {buttonText}
      </Button>
    </section>
  );
}

function QueuePanel({
  vaultAddress,
  targetChainId,
  targetChainName,
  shareUnitDecimals,
  requests,
  isLoading,
  isReady,
  nextFulfillableWithdrawalRequestId,
  onSuccess,
}: {
  vaultAddress: Address;
  targetChainId: number;
  targetChainName: string;
  shareUnitDecimals: number;
  requests: WithdrawalRequestView[];
  isLoading: boolean;
  isReady: boolean;
  nextFulfillableWithdrawalRequestId?: bigint;
  onSuccess: () => void;
}) {
  const cancelRedeem = useCancelRedeem();
  const fulfillNext = useFulfillNextRedeem();
  const cancelConfirmedRef = useRef(false);
  const fulfillConfirmedRef = useRef(false);
  const hasFulfillable = nextFulfillableWithdrawalRequestId != null && nextFulfillableWithdrawalRequestId > 0n;

  useEffect(() => {
    if (cancelRedeem.isSuccess && !cancelConfirmedRef.current) {
      cancelConfirmedRef.current = true;
      toast.success('Withdrawal request cancelled');
      cancelRedeem.reset();
      onSuccess();
    }
    if (!cancelRedeem.isSuccess) {
      cancelConfirmedRef.current = false;
    }
  }, [cancelRedeem, onSuccess]);

  useEffect(() => {
    if (fulfillNext.isSuccess && !fulfillConfirmedRef.current) {
      fulfillConfirmedRef.current = true;
      toast.success('Withdrawal request fulfilled');
      fulfillNext.reset();
      onSuccess();
    }
    if (!fulfillNext.isSuccess) {
      fulfillConfirmedRef.current = false;
    }
  }, [fulfillNext, onSuccess]);

  const onCancel = (requestId: bigint) => {
    if (!isReady) {
      toast.error(`Switch to ${targetChainName} first`);
      return;
    }
    cancelRedeem.cancelRedeem(vaultAddress, requestId, targetChainId, {
      onHash(h) { addTx(h, `Cancel withdrawal request #${requestId.toString()}`, targetChainId); },
      onError(e) {
        toast.error(`Cancel failed: ${e.message.slice(0, 100)}`);
        cancelRedeem.reset();
      },
    });
  };

  const onFulfillNext = () => {
    if (!isReady) {
      toast.error(`Switch to ${targetChainName} first`);
      return;
    }
    fulfillNext.fulfillNextRedeem(vaultAddress, targetChainId, {
      onHash(h) { addTx(h, 'Fulfill next Hyperliquid withdrawal', targetChainId); },
      onError(e) {
        toast.error(`Fulfill failed: ${e.message.slice(0, 100)}`);
        fulfillNext.reset();
      },
    });
  };

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Withdrawal queue</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Requests are served FIFO. Pending requests can be cancelled before fulfillment.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!isReady || !hasFulfillable || fulfillNext.isPending || fulfillNext.isConfirming}
          onClick={onFulfillNext}
        >
          {fulfillNext.isPending || fulfillNext.isConfirming ? 'Fulfilling...' : 'Fulfill next'}
        </Button>
      </div>

      <div className="mt-4 overflow-x-auto">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading queue...</p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No withdrawal requests for your wallet.</p>
        ) : (
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Request</th>
                <th className="py-2 pr-3 font-medium">Shares</th>
                <th className="py-2 pr-3 font-medium">Created</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => {
                const status = requestStatus(request);
                const canCancel = status === 'pending' && !cancelRedeem.isPending && !cancelRedeem.isConfirming;
                return (
                  <tr key={request.id.toString()} className="border-b last:border-0">
                    <td className="py-3 pr-3 font-mono text-xs">#{request.id.toString()}</td>
                    <td className="py-3 pr-3">{formatShares(request.shares, shareUnitDecimals)}</td>
                    <td className="py-3 pr-3 text-muted-foreground">{formatTimestamp(request.createdAt)}</td>
                    <td className="py-3 pr-3">{status}</td>
                    <td className="py-3 text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!isReady || !canCancel}
                        onClick={() => onCancel(request.id)}
                      >
                        Cancel
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-semibold">{value}</dd>
    </div>
  );
}

function formatAsset(amount: bigint | undefined, decimals: number, symbol: string): string {
  if (amount == null) return 'N/A';
  return `${formatNumber(Number(formatUnits(amount, decimals)), { maximumFractionDigits: 6 })} ${symbol}`;
}
