import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import {
  useAccount,
  useWriteContract,
  useSwitchChain,
} from 'wagmi';
import { useStore } from '@nanostores/react';
import { encodeAbiParameters, parseAbiParameters, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { Card, CardContent } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '~/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '~/components/ui/tabs';
import { Identicon } from '~/components/shared/Identicon';
import { toast } from 'sonner';
import { tangleJobsAbi, tangleServicesAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { networks } from '~/lib/contracts/chains';
import { publicClient, selectedChainIdStore } from '~/lib/contracts/publicClient';
import { useOperators } from '~/lib/hooks/useOperators';
import { useQuotes } from '~/lib/hooks/useQuotes';
import { addTx } from '~/lib/stores/txHistory';
import {
  provisionsForOwner,
  addProvision,
  type ProvisionPhase,
} from '~/lib/stores/provisions';

export const meta: MetaFunction = () => [
  { title: 'Deploy Agent — AI Trading Arena' },
];

// ── Full sidecar agent template ──────────────────────────────────────────

function buildFullInstructions(expertKnowledge: string, strategyType: string): string {
  return `# Trading Agent Instructions

## Identity & Autonomy

You are an autonomous trading agent — a coding agent that writes Python scripts, manages its own SQLite database, and iterates on its tools. You are NOT a chatbot. You act.

You have a persistent workspace at /home/agent/ that survives across iterations. You build tools, discover markets, track performance, and improve your approach over time. Every iteration should leave your workspace in a better state than you found it.

Workspace layout:
\`\`\`
/home/agent/
├── data/trading.db        # SQLite — all persistent data
├── tools/                 # Your Python scripts (scanner, analyzer, tracker)
├── memory/insights.jsonl  # Append-only learning log
├── metrics/latest.json    # Current metrics (read by /metrics endpoint)
├── logs/decisions.jsonl   # Trade decision log
└── state/phase.json       # Current phase + iteration counter
\`\`\`

## Iteration Protocol

Read \`/home/agent/state/phase.json\` at the start of every iteration. Follow the phase protocol:

- **bootstrap** (iteration 0): Install packages, build core tools (market scanner, signal analyzer, trade tracker), discover initial markets, populate the DB. Then set phase to "research".
- **research**: Run your scanner tools, update market data in the DB, generate signals. If actionable signals found, set phase to "trading". Otherwise increment iteration and stay in "research".
- **trading**: Check circuit breaker first. Validate trade intents, execute approved trades, log results to the DB. Then set phase to "reflect".
- **reflect**: Calculate P&L from recent trades. Compare your signal predictions vs actual outcomes. Write insights to memory table and insights.jsonl. Set phase to "research".

After each iteration, update \`phase.json\` with the new phase and incremented iteration count.

## Tool Building Guidelines

Build standalone Python scripts in \`/home/agent/tools/\`. Each tool should:
- Accept command-line arguments (e.g. \`python3 tools/scanner.py --source coingecko --limit 50\`)
- Output JSON to stdout for easy parsing
- Use SQLite (\`/home/agent/data/trading.db\`) for persistence
- Handle errors gracefully — print error JSON, don't crash
- Be idempotent — safe to re-run

On subsequent iterations, run existing tools rather than rebuilding them. Only modify tools when you identify a concrete improvement.

## Common Data APIs

These free APIs are available for market discovery and analysis:

| API | Endpoint | Auth | Use |
|-----|----------|------|-----|
| CoinGecko | https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd | None (30 req/min) | Crypto prices |
| CoinGecko | https://api.coingecko.com/api/v3/coins/{{id}}/market_chart?vs_currency=usd&days=30 | None | Price history |
| DeFiLlama | https://yields.llama.fi/pools | None | DeFi pool yields |
| DeFiLlama | https://api.llama.fi/protocol/{{name}} | None | Protocol TVL |
| DexScreener | https://api.dexscreener.com/latest/dex/tokens/{{address}} | None | DEX pair data |
| DexScreener | https://api.dexscreener.com/latest/dex/pairs/{{chain}}/{{pair_address}} | None | Specific pair |

## Trading HTTP API

Base URL: {{injected by operator — trading API URL}}
Authorization: Bearer {{injected by operator — API token}}

Endpoints:
- POST /market-data/prices — Get current token prices. Body: {"tokens": ["ETH", "BTC"]}
- POST /portfolio/state — Get current portfolio positions
- POST /validate — Submit a trade intent for validator approval
  Body: {"strategy_id": "...", "action": "swap", "token_in": "0x...", "token_out": "0x...", "amount_in": "1000", "min_amount_out": "950", "target_protocol": "uniswap_v3"}
- POST /execute — Execute an approved trade on-chain
  Body: {"intent": {...}, "validation": {...}}
- POST /circuit-breaker/check — Check if circuit breaker is triggered
  Body: {"max_drawdown_pct": 10.0}
- GET /adapters — List available protocol adapters
- GET /metrics — Get bot metrics and paper trade status

## Configuration

- Vault Address: {{injected by operator}}
- Chain ID: {{injected by operator}}
- Strategy: ${strategyType}

## Risk Parameters

{{injected by operator — JSON risk parameters}}

## Expert Strategy Knowledge

${expertKnowledge}

## Operational Mandates

1. **Metrics**: Write metrics to /home/agent/metrics/latest.json every iteration:
   {"timestamp": "<ISO8601>", "iteration": <n>, "portfolio_value_usd": <f64>, "pnl_pct": <f64>, "trades_executed": <n>, "strategy": "${strategyType}", "signals_generated": <n>, "phase": "<current_phase>", "errors": []}

2. **Iteration**: Before each run, check /home/agent/tools/ for existing scripts. Run them, don't rebuild. Log every trade decision to /home/agent/logs/decisions.jsonl with reasoning.

3. **Safety**: Always check the circuit breaker before executing trades. Never exceed risk parameters. If uncertain, skip the trade and log why.

4. **Mode**: {{injected by operator — PAPER TRADE or LIVE TRADE mode note}}

5. **Learning**: After every trade outcome (win or loss), write an insight to the memory table. Track which signal types are most accurate. Adjust your approach based on data, not intuition.`;
}

// ── Strategy Pack definitions ────────────────────────────────────────────

interface StrategyPackDef {
  id: string;
  name: string;
  providers: string[];
  description: string;
  cron: string;
  maxTurns: number;
  timeoutMs: number;
  expertKnowledge: string;
}

const strategyPacks: StrategyPackDef[] = [
  {
    id: 'dex',
    name: 'DEX Spot Trading',
    providers: ['Uniswap V3', 'CoinGecko'],
    description:
      'Spot trading on decentralized exchanges. Discovers pools, tracks prices, executes swaps.',
    cron: '0 */5 * * * *',
    maxTurns: 12,
    timeoutMs: 150_000,
    expertKnowledge: `### Uniswap V3 Expert Knowledge

Key Contracts (Ethereum Mainnet):
- Router: 0xE592427A0AEce92De3Edee1F18E0157C05861564
- Quoter V2: 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
- Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
- WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
- USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

Fee tiers: 500 (0.05%), 3000 (0.3%), 10000 (1%)

Build tools for:
1. Pool discovery via DexScreener API
2. Price monitoring via CoinGecko
3. Quote estimation via Quoter V2
4. Swap intent generation through Router

### CoinGecko Integration
- Price API: /api/v3/simple/price
- Market chart: /api/v3/coins/{id}/market_chart
- Rate limit: 30 requests/minute (free tier)`,
  },
  {
    id: 'prediction',
    name: 'Prediction Market Trading',
    providers: ['Polymarket', 'CoinGecko'],
    description: 'Trades event outcomes on Polymarket using the CLOB API.',
    cron: '0 */3 * * * *',
    maxTurns: 20,
    timeoutMs: 240_000,
    expertKnowledge: `### Polymarket Expert Knowledge

APIs:
- Gamma (market discovery): https://gamma-api.polymarket.com/markets
- CLOB (order placement): https://clob.polymarket.com
- Prices: GET /prices?token_ids=...

Key Contracts:
- CTF Exchange: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
- Neg Risk CTF Exchange: 0xC5d563A36AE78145C45a50134d48A1215220f80a
- Neg Risk Adapter: 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045

CLOB Order Flow:
1. GET /markets → discover active markets
2. GET /book?token_id=... → get order book
3. POST /order → place limit order (needs API key + L1/L2 headers)

Build probability estimation tools from news analysis and market data cross-referencing.`,
  },
  {
    id: 'yield',
    name: 'DeFi Yield Optimization',
    providers: ['Aave V3', 'Morpho', 'CoinGecko'],
    description: 'Finds the best DeFi lending/borrowing yields across protocols.',
    cron: '0 */15 * * * *',
    maxTurns: 10,
    timeoutMs: 120_000,
    expertKnowledge: `### Aave V3 Expert Knowledge

Key Contracts:
- Pool: 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
- PoolDataProvider: 0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3

Query reserve data for supply/borrow APYs. Use getReserveData(asset) for current rates.

### Morpho Blue Expert Knowledge

- Morpho Blue: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
- Uses market IDs (bytes32) for isolated lending markets
- Higher yields but more granular risk assessment needed

### Cross-Protocol Yield Strategy

Use DeFiLlama yields API (https://yields.llama.fi/pools) to compare rates across ALL protocols.
Rebalance when rate differential exceeds 50bps after gas costs.`,
  },
  {
    id: 'perp',
    name: 'Perpetual Futures',
    providers: ['GMX V2', 'Hyperliquid', 'Vertex', 'CoinGecko'],
    description: 'Cross-venue perpetual futures with funding rate arbitrage.',
    cron: '0 */2 * * * *',
    maxTurns: 15,
    timeoutMs: 180_000,
    expertKnowledge: `### GMX V2 (Arbitrum)
- Router: 0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8
- Reader: 0xf60becbba223EEA9495Da3f606753867eC10d139

### Hyperliquid
- REST: https://api.hyperliquid.xyz
- WebSocket: wss://api.hyperliquid.xyz/ws
- POST /info for meta, funding, positions
- POST /exchange for orders

### Vertex
- REST: https://prod.vertexprotocol-backend.com
- Query engine for positions, orderbook

### Cross-Venue Funding Rate Arbitrage

When funding rates diverge between GMX and Hyperliquid:
1. Long on the venue with negative funding (you get paid)
2. Short on the venue with positive funding (you get paid)
3. Net delta-neutral, collect funding from both sides
4. Minimum spread: 0.03%/8h to cover execution costs`,
  },
  {
    id: 'volatility',
    name: 'Volatility Trading',
    providers: ['Polymarket', 'Uniswap V3', 'GMX V2', 'Hyperliquid', 'Vertex', 'CoinGecko'],
    description:
      'Trades implied vs realized volatility using funding rates and prediction markets.',
    cron: '0 */10 * * * *',
    maxTurns: 12,
    timeoutMs: 150_000,
    expertKnowledge: `### Implied Volatility Proxies

Crypto markets lack traditional options IV. Use these proxies:
- **Funding rates** from Hyperliquid: High absolute funding = high implied vol
- **Prediction market spreads**: Wide bid-ask on Polymarket crypto markets = uncertainty
- **Price momentum**: Rapid price changes (>3% in 1h) signal vol regime change

### Vol Trading Strategies

**Long Volatility** (when realized vol < implied proxies):
- Buy both YES and NO sides of crypto prediction markets near 50/50 split
- Long perpetual positions with tight stops — capture large moves in either direction

**Short Volatility** (when realized vol > implied proxies):
- Sell prediction market positions far from 50/50 (>75% or <25%) — collect theta decay
- Provide DEX liquidity, collect high funding on perps

### Delta Hedging
- Calculate net delta across all positions
- Hedge via Uniswap V3 spot trades to bring net delta near zero
- Re-hedge when delta drifts beyond ±5% of portfolio`,
  },
  {
    id: 'mm',
    name: 'Market Making',
    providers: ['Polymarket', 'Hyperliquid', 'Uniswap V3', 'CoinGecko'],
    description: 'Automated market making with inventory management and spread calculation.',
    cron: '0 */1 * * * *',
    maxTurns: 15,
    timeoutMs: 180_000,
    expertKnowledge: `### Market Selection
Select 3-5 markets: Volume > $100k, spread < 3%, moderate volatility.

### Fair Value Estimation
1. Fetch order book (bids + asks)
2. Midpoint = (best_bid + best_ask) / 2
3. Adjust for recent trade flow

### Inventory Management
- Max 10% per market, target inventory = 0 (flat)
- Skew quotes: shift midpoint by inventory_skew * base_spread
- Stop quoting one side if inventory > 15%

### Spread Calculation
- Low vol, balanced: 0.5-1% base spread
- High vol: widen by vol_multiplier
- Minimum: must cover fees + adverse selection

### Circuit Breakers
- Stop quoting if session drawdown > 2%
- Pause market on 3 consecutive adverse fills
- Reduce size 50% if drawdown > 1%/hour`,
  },
  {
    id: 'multi',
    name: 'Cross-Strategy',
    providers: ['All protocols'],
    description: 'Allocates capital across prediction, yield, perps, and spot strategies.',
    cron: '0 */5 * * * *',
    maxTurns: 20,
    timeoutMs: 300_000,
    expertKnowledge: `### Capital Allocation Model

Default allocation:
- 30% Prediction markets (Polymarket)
- 25% DeFi yield (Aave V3, Morpho)
- 25% Perpetual futures (GMX V2, Vertex)
- 20% Spot/DEX (Uniswap V3)

Rebalance weekly by Sharpe ratio:
- Sharpe > 1.5: increase allocation +5%
- Sharpe < 0.5: decrease allocation -5%
- Never > 40% or < 10% per strategy

### Cross-Strategy Signal Integration
- Crypto prices → inform prediction bets
- Yield data → guide capital allocation
- Funding rates → directional bias for perps + predictions
- Volatility spikes → reduce all exposure, increase cash

### Risk Management (Portfolio-Wide)
- Maximum 3% daily drawdown across all strategies
- Per-strategy drawdown limit: 5%
- Cash buffer: always keep 10% in stablecoins`,
  },
];

// ── Wizard helpers ───────────────────────────────────────────────────────

type WizardStep = 'blueprint' | 'service' | 'configure' | 'deploy';

const STEP_ORDER: WizardStep[] = ['blueprint', 'service', 'configure', 'deploy'];
const STEP_LABELS: Record<WizardStep, string> = {
  blueprint: 'Blueprint',
  service: 'Service',
  configure: 'Configure',
  deploy: 'Deploy',
};

function phaseLabel(phase: ProvisionPhase): string {
  switch (phase) {
    case 'pending_confirmation':
      return 'Confirming';
    case 'job_submitted':
      return 'Submitted';
    case 'job_processing':
      return 'Processing';
    case 'active':
      return 'Active';
    case 'failed':
      return 'Failed';
  }
}

function phaseDotClass(phase: ProvisionPhase): string {
  switch (phase) {
    case 'pending_confirmation':
      return 'bg-amber-400 animate-pulse';
    case 'job_submitted':
      return 'bg-amber-400 animate-pulse';
    case 'job_processing':
      return 'bg-amber-400 animate-pulse';
    case 'active':
      return 'bg-arena-elements-icon-success';
    case 'failed':
      return 'bg-crimson-400';
  }
}

function timeAgo(ts: number): string {
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
function formatCost(scaled: bigint): string {
  const usd = Number(scaled) / 1e9;
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

function cronToHuman(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length < 6) return cron;
  const min = parts[1];
  if (min.startsWith('*/')) {
    const n = parseInt(min.slice(2));
    return n === 1 ? '1 min' : `${n} min`;
  }
  return cron;
}

// ── Service info type ────────────────────────────────────────────────────

interface ServiceInfo {
  blueprintId: number;
  owner: Address;
  operators: Address[];
  operatorCount: number;
  ttl: number;
  createdAt: number;
  status: number; // 0=Pending, 1=Active, 2=Terminated
  isActive: boolean;
  isPermitted: boolean;
}

// ── Main page ────────────────────────────────────────────────────────────

export default function ProvisionPage() {
  const { address: userAddress, isConnected, chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const selectedChainId = useStore(selectedChainIdStore);
  const selectedNetwork = networks[selectedChainId]!;
  const targetChain = selectedNetwork.chain;
  const isWrongChain = isConnected && walletChainId !== targetChain.id;

  /** Ensure wallet is on tangleLocal before sending a TX. Returns true if ready. */
  const ensureCorrectChain = useCallback(async (): Promise<boolean> => {
    if (!isConnected) {
      toast.error('Connect wallet first');
      return false;
    }
    if (walletChainId === targetChain.id) return true;

    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      toast.error('No wallet provider found');
      return false;
    }

    const chainIdHex = `0x${targetChain.id.toString(16)}`;

    // Step 1: Try switching directly
    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      });
      return true;
    } catch (switchErr: any) {
      // 4902 = chain not added yet
      if (switchErr?.code !== 4902) {
        // Try adding the chain as fallback for any error
      }
    }

    // Step 2: Add the chain, then switch
    try {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: chainIdHex,
          chainName: targetChain.name,
          nativeCurrency: targetChain.nativeCurrency,
          rpcUrls: targetChain.rpcUrls.default.http,
        }],
      });
      // Adding often auto-switches, but try explicit switch too
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      }).catch(() => {}); // ignore if already switched
      return true;
    } catch {
      toast.error(`Add chain ${targetChain.id} (${targetChain.name}) to your wallet manually`);
      return false;
    }
  }, [isConnected, walletChainId]);

  // Wizard navigation
  const [step, setStep] = useState<WizardStep>('blueprint');
  const [blueprintId, setBlueprintId] = useState(import.meta.env.VITE_BLUEPRINT_ID ?? '0');

  // Step 2 — service
  const [serviceMode, setServiceMode] = useState<'existing' | 'new'>('existing');
  const [serviceId, setServiceId] = useState('0');
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  // New service deployment
  const [selectedOperators, setSelectedOperators] = useState<Set<Address>>(new Set());
  const [manualOperator, setManualOperator] = useState('');
  const [newServiceTxHash, setNewServiceTxHash] = useState<`0x${string}` | undefined>();
  const [newServiceDeploying, setNewServiceDeploying] = useState(false);

  // Step 3 — configure
  const [name, setName] = useState('');
  const [strategyType, setStrategyType] = useState('dex');
  const [customInstructions, setCustomInstructions] = useState('');
  const [customExpertKnowledge, setCustomExpertKnowledge] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [customMaxTurns, setCustomMaxTurns] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Step 4 — deploy
  const { writeContract, data: txHash, isPending, error: txError, reset: resetTx } =
    useWriteContract();

  // Provisions store
  const ownerProvisions = useMemo(() => provisionsForOwner(userAddress), [userAddress]);
  const myProvisions = useStore(ownerProvisions);

  // Operator discovery for blueprint step + new service mode
  const blueprintIdBig = useMemo(() => BigInt(blueprintId || '0'), [blueprintId]);
  const { operators: discoveredOperators, operatorCount } = useOperators(blueprintIdBig);

  // Quotes for new service mode
  const selectedOps = useMemo(
    () => discoveredOperators.filter((op) => selectedOperators.has(op.address)),
    [discoveredOperators, selectedOperators],
  );
  const ttlBlocks = useMemo(() => BigInt((30 * 86400) / 12), []); // ~30 days at 12s/block
  const quotesEnabled = selectedOperators.size > 0 && serviceMode === 'new';
  const {
    quotes,
    isLoading: isQuoting,
    errors: quoteErrors,
    totalCost,
    refetch: refetchQuotes,
  } = useQuotes(selectedOps, blueprintIdBig, ttlBlocks, quotesEnabled);

  // Second writeContract for new service (separate from job submission)
  const {
    writeContract: writeNewService,
    data: newServiceWriteHash,
    isPending: isNewServicePending,
    error: newServiceError,
  } = useWriteContract();

  const selectedPack = strategyPacks.find((p) => p.id === strategyType)!;
  const effectiveExpert = customExpertKnowledge || selectedPack.expertKnowledge;
  const effectiveCron = customCron || selectedPack.cron;
  const fullInstructions = buildFullInstructions(effectiveExpert, strategyType);

  // Reset customizations when strategy changes
  useEffect(() => {
    setCustomExpertKnowledge('');
    setCustomInstructions('');
    setCustomCron('');
    setCustomMaxTurns('');
  }, [strategyType]);

  // Reset new service deploying state when leaving service step or switching modes
  useEffect(() => {
    if (step !== 'service' || serviceMode !== 'new') {
      setNewServiceDeploying(false);
    }
  }, [step, serviceMode]);

  // Track TX in history + create provision entry
  useEffect(() => {
    if (!txHash || !userAddress) return;
    addTx(txHash, `Deploy ${name || 'Agent'} (${selectedPack?.name})`, targetChain.id);
    addProvision({
      id: txHash,
      owner: userAddress,
      name: name || 'Agent',
      strategyType,
      operators: serviceInfo?.operators ?? [],
      blueprintId,
      txHash,
      serviceId: serviceInfo ? Number(serviceId) : undefined,
      jobIndex: 0,
      phase: 'pending_confirmation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chainId: targetChain.id,
    });
  }, [txHash]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (txError) toast.error(`Transaction failed: ${txError.message.slice(0, 120)}`);
  }, [txError]);

  // Track new service TX hash — wallet confirmed, now we're deploying
  useEffect(() => {
    if (newServiceWriteHash) {
      setNewServiceTxHash(newServiceWriteHash);
      setNewServiceDeploying(true);
    }
  }, [newServiceWriteHash]);

  useEffect(() => {
    if (newServiceError) {
      toast.error(`New service failed: ${newServiceError.message.slice(0, 120)}`);
      setNewServiceDeploying(false);
    }
  }, [newServiceError]);

  // Wait for new service TX receipt
  useEffect(() => {
    if (!newServiceTxHash || !newServiceDeploying) return;
    publicClient
      .waitForTransactionReceipt({ hash: newServiceTxHash })
      .then((receipt) => {
        if (receipt.status === 'success') {
          toast.success('Service request submitted! Waiting for activation...');
        } else {
          toast.error('Service request transaction reverted');
          setNewServiceDeploying(false);
        }
      })
      .catch(() => {
        toast.error('Failed to confirm service request');
        setNewServiceDeploying(false);
      });
  }, [newServiceTxHash, newServiceDeploying]);

  // Watch for ServiceActivated when deploying new service
  useEffect(() => {
    if (!newServiceDeploying) return;
    const unwatch = publicClient.watchContractEvent({
      address: addresses.tangle,
      abi: tangleServicesAbi,
      eventName: 'ServiceActivated',
      onLogs(logs) {
        for (const log of logs) {
          const bid = log.args.blueprintId;
          const sid = log.args.serviceId;
          if (bid == null || sid == null) continue;
          if (Number(bid) === Number(blueprintId)) {
            const activatedId = Number(sid).toString();
            setServiceId(activatedId);
            setServiceMode('existing');
            setNewServiceDeploying(false);
            toast.success(`Service ${activatedId} activated!`);
            // Trigger validation of the newly created service
            setTimeout(() => setStep('service'), 100);
          }
        }
      },
    });
    return unwatch;
  }, [newServiceDeploying, blueprintId]);

  // ── Service validation ─────────────────────────────────────────────────

  const validateService = useCallback(async () => {
    setServiceLoading(true);
    setServiceError(null);
    setServiceInfo(null);

    try {
      const sid = BigInt(serviceId);

      const [isActive, service, operators] = await Promise.all([
        publicClient.readContract({
          address: addresses.tangle,
          abi: tangleServicesAbi,
          functionName: 'isServiceActive',
          args: [sid],
        }),
        publicClient.readContract({
          address: addresses.tangle,
          abi: tangleServicesAbi,
          functionName: 'getService',
          args: [sid],
        }),
        publicClient.readContract({
          address: addresses.tangle,
          abi: tangleServicesAbi,
          functionName: 'getServiceOperators',
          args: [sid],
        }),
      ]);

      const svc = service as {
        blueprintId: bigint;
        owner: Address;
        createdAt: bigint;
        ttl: bigint;
        terminatedAt: bigint;
        lastPaymentAt: bigint;
        operatorCount: number;
        minOperators: number;
        maxOperators: number;
        membership: number;
        pricing: number;
        status: number;
      };

      let isPermitted = true;
      if (userAddress) {
        isPermitted = await publicClient.readContract({
          address: addresses.tangle,
          abi: tangleServicesAbi,
          functionName: 'isPermittedCaller',
          args: [sid, userAddress],
        });
      }

      if (Number(svc.blueprintId) !== Number(blueprintId)) {
        setServiceError(
          `Service ${serviceId} belongs to blueprint ${svc.blueprintId}, not ${blueprintId}`,
        );
        setServiceLoading(false);
        return;
      }

      setServiceInfo({
        blueprintId: Number(svc.blueprintId),
        owner: svc.owner,
        operators: operators as Address[],
        operatorCount: svc.operatorCount,
        ttl: Number(svc.ttl),
        createdAt: Number(svc.createdAt),
        status: svc.status,
        isActive,
        isPermitted,
      });
    } catch (err) {
      setServiceError(
        err instanceof Error ? err.message.slice(0, 120) : 'Failed to fetch service',
      );
    } finally {
      setServiceLoading(false);
    }
  }, [serviceId, blueprintId, userAddress]);

  // Auto-validate when entering service step (existing mode only)
  useEffect(() => {
    if (step === 'service' && serviceMode === 'existing') {
      validateService();
    }
  }, [step, serviceId, serviceMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Submit job ─────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!(await ensureCorrectChain()) || !userAddress) return;
    if (!name.trim()) {
      toast.error('Enter agent name');
      return;
    }

    const strategyConfig: Record<string, unknown> = {};
    if (customExpertKnowledge) strategyConfig.expert_knowledge_override = customExpertKnowledge;
    if (customInstructions) strategyConfig.custom_instructions = customInstructions;

    const inputs = encodeAbiParameters(
      parseAbiParameters(
        'string, string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[]',
      ),
      [
        name,
        strategyType,
        JSON.stringify(strategyConfig),
        '{}',
        '{}',
        zeroAddress,
        (import.meta.env.VITE_USDC_ADDRESS ??
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') as Address,
        [userAddress],
        1n,
        BigInt(targetChain.id),
        '',
        effectiveCron,
        2n,
        2048n,
        30n,
        [],
      ],
    );

    writeContract({
      address: addresses.tangle,
      abi: tangleJobsAbi,
      functionName: 'submitJob',
      chainId: targetChain.id,
      args: [BigInt(serviceId), 0, inputs],
    });
  };

  // ── New service deployment ────────────────────────────────────────────

  const toggleOperator = useCallback((addr: Address) => {
    setSelectedOperators((prev) => {
      const n = new Set(prev);
      if (n.has(addr)) n.delete(addr);
      else n.add(addr);
      return n;
    });
  }, []);

  const addManualOperator = useCallback(() => {
    const t = manualOperator.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(t)) {
      setSelectedOperators((prev) => new Set(prev).add(t as Address));
      setManualOperator('');
    } else {
      toast.error('Invalid address');
    }
  }, [manualOperator]);

  const handleDeployNewService = async () => {
    if (!(await ensureCorrectChain()) || !userAddress) return;
    if (quotes.length === 0) {
      toast.error('No quotes available — select operators first');
      return;
    }

    // Encode a minimal config for the service
    const config = encodeAbiParameters(
      parseAbiParameters(
        'string, string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[]',
      ),
      [
        '',
        '',
        '{}',
        '{}',
        '{}',
        zeroAddress,
        (import.meta.env.VITE_USDC_ADDRESS ??
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') as Address,
        [userAddress],
        1n,
        BigInt(targetChain.id),
        '',
        '',
        2n,
        2048n,
        30n,
        [],
      ],
    );

    // Build signed quote tuples for createServiceFromQuotes
    const quoteTuples = quotes.map((q) => ({
      details: {
        blueprintId: q.details.blueprintId,
        ttlBlocks: q.details.ttlBlocks,
        totalCost: q.details.totalCost,
        timestamp: q.details.timestamp,
        expiry: q.details.expiry,
        securityCommitments: q.details.securityCommitments.map((sc) => ({
          asset: { kind: sc.asset.kind, token: sc.asset.token },
          exposureBps: sc.exposureBps,
        })),
      },
      signature: q.signature,
      operator: q.operator,
    }));

    writeNewService({
      address: addresses.tangle,
      abi: tangleServicesAbi,
      functionName: 'createServiceFromQuotes',
      chainId: targetChain.id,
      args: [BigInt(blueprintId), quoteTuples, config, [userAddress], ttlBlocks],
      value: totalCost,
    });
  };

  // ── Step navigation ────────────────────────────────────────────────────

  const stepIndex = STEP_ORDER.indexOf(step);

  const canNext = (() => {
    switch (step) {
      case 'blueprint':
        return !!blueprintId;
      case 'service':
        return serviceMode === 'existing'
          ? serviceInfo != null && serviceInfo.isActive
          : false; // new service flow handles its own navigation
      case 'configure':
        return !!name.trim();
      case 'deploy':
        return false;
    }
  })();

  const goNext = () => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) setStep(STEP_ORDER[idx + 1]);
  };

  const goBack = () => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx > 0) setStep(STEP_ORDER[idx - 1]);
  };

  const latestDeployment = myProvisions.find((p) => p.txHash === txHash);

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-arena-elements-textTertiary hover:text-violet-700 dark:hover:text-violet-400 mb-6 font-display font-medium transition-colors"
      >
        <span>&larr;</span> Leaderboard
      </Link>

      <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">
        Deploy Trading Agent
      </h1>
      <p className="text-base text-arena-elements-textSecondary mb-6">
        {step === 'blueprint' && 'Select a blueprint to deploy your trading agent.'}
        {step === 'service' &&
          (serviceMode === 'new'
            ? 'Deploy a new service with your chosen operators.'
            : 'Select an existing service to submit a provision job.')}
        {step === 'configure' && 'Configure your agent strategy and parameters.'}
        {step === 'deploy' && 'Review and submit your provision job.'}
      </p>

      {/* Step indicator */}
      <div className="flex items-center gap-1 mb-8">
        {STEP_ORDER.map((s, i) => {
          const isCurrent = s === step;
          const isDone = i < stepIndex;
          return (
            <div key={s} className="flex items-center gap-1 flex-1">
              <button
                type="button"
                onClick={() => {
                  if (isDone) setStep(s);
                }}
                disabled={!isDone && !isCurrent}
                className={`flex items-center gap-2 text-sm font-display font-medium transition-colors ${
                  isCurrent
                    ? 'text-violet-700 dark:text-violet-400'
                    : isDone
                      ? 'text-arena-elements-textSecondary hover:text-violet-600 dark:hover:text-violet-400 cursor-pointer'
                      : 'text-arena-elements-textTertiary cursor-default'
                }`}
              >
                <span
                  className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-data font-bold shrink-0 ${
                    isCurrent
                      ? 'bg-violet-500 text-white'
                      : isDone
                        ? 'bg-arena-elements-icon-success text-white'
                        : 'bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 text-arena-elements-textTertiary border border-arena-elements-borderColor'
                  }`}
                >
                  {isDone ? '\u2713' : i + 1}
                </span>
                <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
              </button>
              {i < STEP_ORDER.length - 1 && (
                <div
                  className={`flex-1 h-px mx-1 ${i < stepIndex ? 'bg-arena-elements-icon-success' : 'bg-arena-elements-borderColor'}`}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="space-y-5">
        {/* Wrong chain banner */}
        {isWrongChain && (
          <div className="flex items-center gap-3 p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <div className="w-3 h-3 rounded-full bg-amber-500 animate-pulse shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-display font-medium text-amber-700 dark:text-amber-400">
                Wrong Network
              </div>
              <div className="text-xs text-arena-elements-textSecondary mt-0.5">
                Your wallet is on chain {walletChainId}. Switch to {targetChain.name} to submit transactions.
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => switchChainAsync({ chainId: targetChain.id }).catch(() =>
                toast.error('Failed to switch — add the chain to your wallet manually')
              )}
            >
              Switch Network
            </Button>
          </div>
        )}

        {/* ── Step 1: Blueprint ──────────────────────────────────────── */}
        {step === 'blueprint' && (
          <>
            <Card>
              <CardContent className="pt-5 pb-5 space-y-4">
                <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                  Select Blueprint
                </label>
                <div className="w-full text-left rounded-lg border border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20 px-4 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-base font-display font-semibold text-violet-700 dark:text-violet-400">
                        AI Trading Blueprint
                      </div>
                      <div className="text-sm text-arena-elements-textSecondary mt-0.5">
                        Autonomous trading agents with sidecar execution
                      </div>
                    </div>
                    <Badge variant="success" className="text-xs shrink-0">
                      Selected
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <label className="text-xs font-data text-arena-elements-textSecondary shrink-0">
                    Blueprint ID
                  </label>
                  <Input
                    type="number"
                    min="0"
                    value={blueprintId}
                    onChange={(e) => setBlueprintId(e.target.value)}
                    className="w-24 h-9 text-sm"
                  />
                  {operatorCount > 0n && (
                    <span className="text-xs text-arena-elements-textSecondary">
                      {operatorCount.toString()} operator{operatorCount > 1n ? 's' : ''} registered
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
            <div className="flex justify-end">
              <Button onClick={goNext} disabled={!canNext} size="lg">
                Next: Select Service
              </Button>
            </div>
          </>
        )}

        {/* ── Step 2: Service ────────────────────────────────────────── */}
        {step === 'service' && (
          <>
            {/* Mode toggle */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setServiceMode('existing')}
                className={`flex-1 rounded-lg border px-4 py-3 text-left transition-all ${
                  serviceMode === 'existing'
                    ? 'border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20'
                    : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                }`}
              >
                <div
                  className={`text-sm font-display font-semibold ${serviceMode === 'existing' ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}
                >
                  Use Existing Service
                </div>
                <div className="text-xs text-arena-elements-textTertiary mt-0.5">
                  Submit a job to a service that's already running
                </div>
              </button>
              <button
                type="button"
                onClick={() => setServiceMode('new')}
                className={`flex-1 rounded-lg border px-4 py-3 text-left transition-all ${
                  serviceMode === 'new'
                    ? 'border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20'
                    : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                }`}
              >
                <div
                  className={`text-sm font-display font-semibold ${serviceMode === 'new' ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}
                >
                  Deploy New Service
                </div>
                <div className="text-xs text-arena-elements-textTertiary mt-0.5">
                  Select operators and create your own service
                </div>
              </button>
            </div>

            {/* Mode A: Existing service */}
            {serviceMode === 'existing' && (
              <Card>
                <CardContent className="pt-5 pb-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-data text-arena-elements-textSecondary shrink-0">
                      Service ID
                    </label>
                    <Input
                      type="number"
                      min="0"
                      value={serviceId}
                      onChange={(e) => setServiceId(e.target.value)}
                      className="w-24 h-9 text-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={validateService}
                      disabled={serviceLoading}
                    >
                      {serviceLoading ? 'Checking...' : 'Verify'}
                    </Button>
                  </div>

                  {serviceError && (
                    <div className="text-sm text-crimson-400 p-3 rounded-lg bg-crimson-500/5 border border-crimson-500/20">
                      {serviceError}
                    </div>
                  )}

                  {serviceInfo && (
                    <div className="p-3.5 rounded-lg bg-arena-elements-item-backgroundHover/30 border border-arena-elements-borderColor/40 space-y-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${serviceInfo.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
                        />
                        <span className="text-sm font-display font-medium text-arena-elements-textPrimary">
                          Service {serviceId} {serviceInfo.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-y-1.5 text-sm font-data">
                        <span className="text-arena-elements-textTertiary">Blueprint</span>
                        <span className="text-arena-elements-textPrimary">
                          {serviceInfo.blueprintId}
                        </span>
                        <span className="text-arena-elements-textTertiary">Owner</span>
                        <span className="text-arena-elements-textPrimary truncate">
                          {serviceInfo.owner}
                        </span>
                        <span className="text-arena-elements-textTertiary">Operators</span>
                        <span className="text-arena-elements-textPrimary">
                          {serviceInfo.operators.length}
                        </span>
                        <span className="text-arena-elements-textTertiary">TTL</span>
                        <span className="text-arena-elements-textPrimary">
                          {serviceInfo.ttl > 0
                            ? `${Math.floor(serviceInfo.ttl / 86400)}d`
                            : 'Unlimited'}
                        </span>
                      </div>
                      {serviceInfo.operators.length > 0 && (
                        <div className="pt-2 space-y-1.5">
                          <span className="text-xs font-data text-arena-elements-textTertiary">
                            Service Operators
                          </span>
                          {serviceInfo.operators.map((addr) => (
                            <div
                              key={addr}
                              className="flex items-center gap-2 px-2 py-1.5 rounded bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1"
                            >
                              <Identicon address={addr} size={20} />
                              <span className="font-data text-xs text-arena-elements-textSecondary truncate">
                                {addr}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {!serviceInfo.isPermitted && userAddress && (
                        <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 pt-1">
                          <span className="text-base">!</span>
                          <span>
                            Your address is not a permitted caller. The transaction may revert.
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Mode B: Deploy new service */}
            {serviceMode === 'new' && (
              <>
                <Card>
                  <CardContent className="pt-5 pb-4 space-y-3">
                    <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                      Select Operators
                    </label>
                    {operatorCount > 0n && (
                      <p className="text-xs text-arena-elements-textSecondary">
                        {operatorCount.toString()} registered for blueprint {blueprintId}
                      </p>
                    )}
                    {discoveredOperators.length > 0 ? (
                      <div className="grid gap-2">
                        {discoveredOperators.map((op) => {
                          const sel = selectedOperators.has(op.address);
                          return (
                            <button
                              key={op.address}
                              type="button"
                              onClick={() => toggleOperator(op.address)}
                              className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                                sel
                                  ? 'border-violet-500/40 bg-violet-500/5'
                                  : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/30 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                              }`}
                            >
                              <Identicon address={op.address} size={28} />
                              <div className="min-w-0 flex-1">
                                <div className="font-data text-sm truncate">{op.address}</div>
                                {op.rpcAddress && (
                                  <div className="text-xs text-arena-elements-textTertiary truncate mt-0.5">
                                    {op.rpcAddress}
                                  </div>
                                )}
                              </div>
                              {sel && (
                                <Badge variant="success" className="text-xs">
                                  Selected
                                </Badge>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="text-sm text-arena-elements-textTertiary py-3">
                        No operators found for blueprint {blueprintId}.
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input
                        placeholder="0x..."
                        value={manualOperator}
                        onChange={(e) => setManualOperator(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addManualOperator()}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addManualOperator}
                        className="text-sm shrink-0"
                      >
                        Add
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* Quotes */}
                {selectedOperators.size > 0 && (
                  <Card>
                    <CardContent className="pt-5 pb-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">
                          Operator Quotes
                        </label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={refetchQuotes}
                          disabled={isQuoting}
                          className="text-xs"
                        >
                          {isQuoting ? 'Fetching...' : 'Refresh'}
                        </Button>
                      </div>
                      {isQuoting && quotes.length === 0 && (
                        <div className="text-sm text-arena-elements-textTertiary py-4 text-center animate-pulse">
                          Solving PoW challenge and fetching quotes...
                        </div>
                      )}
                      {quotes.length > 0 && (
                        <div className="space-y-2">
                          {quotes.map((q) => (
                            <div
                              key={q.operator}
                              className="flex items-center gap-3 p-3 rounded-lg border border-emerald-700/30 bg-emerald-700/5 dark:border-emerald-500/30 dark:bg-emerald-500/5"
                            >
                              <Identicon address={q.operator} size={24} />
                              <div className="min-w-0 flex-1">
                                <div className="font-data text-sm truncate">{q.operator}</div>
                                <div className="text-xs text-arena-elements-textTertiary mt-0.5">
                                  Expires in{' '}
                                  {Math.max(
                                    0,
                                    Number(q.details.expiry) - Math.floor(Date.now() / 1000),
                                  )}
                                  s
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="font-data text-sm text-arena-elements-icon-success">
                                  {formatCost(q.totalCost)}
                                </div>
                              </div>
                            </div>
                          ))}
                          <div className="flex items-center justify-between pt-1 px-1">
                            <span className="text-xs font-data text-arena-elements-textSecondary">
                              Total Cost
                            </span>
                            <span className="font-data text-sm font-semibold text-arena-elements-textPrimary">
                              {formatCost(totalCost)}
                            </span>
                          </div>
                        </div>
                      )}
                      {quoteErrors.size > 0 && (
                        <div className="space-y-1">
                          {Array.from(quoteErrors.entries()).map(([addr, msg]) => (
                            <div key={addr} className="flex items-center gap-2 text-xs text-crimson-400">
                              <Identicon address={addr} size={16} />
                              <span className="truncate">
                                {addr.slice(0, 10)}...{addr.slice(-6)}: {msg}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Deploy new service button */}
                {quotes.length > 0 && (
                  <Card>
                    <CardContent className="pt-5 pb-4">
                      <Button
                        onClick={handleDeployNewService}
                        className="w-full"
                        size="lg"
                        disabled={
                          !isConnected || isNewServicePending || newServiceDeploying || isQuoting
                        }
                      >
                        {!isConnected
                          ? 'Connect Wallet'
                          : isNewServicePending
                            ? 'Confirm in Wallet...'
                            : newServiceDeploying
                              ? 'Waiting for Activation...'
                              : `Deploy New Service (${formatCost(totalCost)})`}
                      </Button>
                      {newServiceDeploying && (
                        <div className="text-center mt-2 space-y-2">
                          <p className="text-xs text-arena-elements-textTertiary animate-pulse">
                            Waiting for operators to approve and activate the service...
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setNewServiceDeploying(false);
                              setNewServiceTxHash(undefined);
                            }}
                            className="text-xs"
                          >
                            Cancel
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={goBack}>
                Back
              </Button>
              {serviceMode === 'existing' && (
                <Button onClick={goNext} disabled={!canNext} size="lg">
                  Next: Configure Agent
                </Button>
              )}
            </div>
          </>
        )}

        {/* ── Step 3: Configure ──────────────────────────────────────── */}
        {step === 'configure' && (
          <>
            <Card>
              <CardContent className="pt-5 pb-4">
                <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Agent Name
                </label>
                <Input
                  placeholder="e.g. Alpha DEX Bot"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5 pb-5 space-y-4">
                <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                  Strategy Profile
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {strategyPacks.map((p) => {
                    const active = strategyType === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setStrategyType(p.id)}
                        className={`text-left rounded-lg border px-3.5 py-3 transition-all duration-150 ${
                          active
                            ? 'border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20'
                            : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                        }`}
                      >
                        <div
                          className={`text-sm font-display font-semibold mb-0.5 ${active ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}
                        >
                          {p.name}
                        </div>
                        <div className="text-xs font-data text-arena-elements-textTertiary leading-snug line-clamp-2">
                          {p.providers.slice(0, 3).join(', ')}
                          {p.providers.length > 3 ? ` +${p.providers.length - 3}` : ''}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between pt-1">
                  <p className="text-sm text-arena-elements-textSecondary leading-relaxed max-w-lg">
                    {selectedPack.description}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAdvanced(true)}
                    className="text-sm shrink-0 ml-4"
                  >
                    Customize
                  </Button>
                </div>
              </CardContent>
            </Card>

            {name.trim() && (
              <Card>
                <CardContent className="pt-5 pb-4">
                  <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-3 block">
                    Summary
                  </label>
                  <div className="grid grid-cols-2 gap-y-1.5 text-sm font-data">
                    <span className="text-arena-elements-textTertiary">Service</span>
                    <span className="text-arena-elements-textPrimary">{serviceId}</span>
                    <span className="text-arena-elements-textTertiary">Agent</span>
                    <span className="text-arena-elements-textPrimary">{name}</span>
                    <span className="text-arena-elements-textTertiary">Strategy</span>
                    <span className="text-arena-elements-textPrimary">{selectedPack.name}</span>
                    <span className="text-arena-elements-textTertiary">Frequency</span>
                    <span className="text-arena-elements-textPrimary">
                      Every {cronToHuman(effectiveCron)}
                    </span>
                    {(customExpertKnowledge || customInstructions) && (
                      <>
                        <span className="text-arena-elements-textTertiary">Custom</span>
                        <span className="text-amber-600 dark:text-amber-400">Modified</span>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={goBack}>
                Back
              </Button>
              <Button onClick={goNext} disabled={!canNext} size="lg">
                Next: Deploy
              </Button>
            </div>
          </>
        )}

        {/* ── Step 4: Deploy ─────────────────────────────────────────── */}
        {step === 'deploy' && (
          <>
            {!txHash && (
              <Card>
                <CardContent className="pt-5 pb-5 space-y-4">
                  <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                    Submit Provision Job
                  </label>
                  <div className="p-3.5 rounded-lg bg-arena-elements-item-backgroundHover/30 border border-arena-elements-borderColor/40">
                    <div className="grid grid-cols-2 gap-y-1.5 text-sm font-data">
                      <span className="text-arena-elements-textTertiary">Service</span>
                      <span className="text-arena-elements-textPrimary">{serviceId}</span>
                      <span className="text-arena-elements-textTertiary">Job</span>
                      <span className="text-arena-elements-textPrimary">
                        submitJob(serviceId={serviceId}, jobIndex=0)
                      </span>
                      <span className="text-arena-elements-textTertiary">Agent</span>
                      <span className="text-arena-elements-textPrimary">{name}</span>
                      <span className="text-arena-elements-textTertiary">Strategy</span>
                      <span className="text-arena-elements-textPrimary">{selectedPack.name}</span>
                      <span className="text-arena-elements-textTertiary">Frequency</span>
                      <span className="text-arena-elements-textPrimary">
                        Every {cronToHuman(effectiveCron)}
                      </span>
                    </div>
                  </div>
                  <Button
                    onClick={handleSubmit}
                    className="w-full"
                    size="lg"
                    disabled={!isConnected || isPending}
                  >
                    {!isConnected
                      ? 'Connect Wallet'
                      : isPending
                        ? 'Confirm in Wallet...'
                        : 'Submit Provision Job'}
                  </Button>
                </CardContent>
              </Card>
            )}

            {txHash && (
              <Card>
                <CardContent className="pt-5 pb-5 space-y-4">
                  <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                    Deployment Progress
                  </label>
                  <div className="space-y-3">
                    <LifecycleStage
                      label="Submitted"
                      description="Transaction confirmed on-chain"
                      status={
                        latestDeployment?.phase === 'pending_confirmation'
                          ? 'active'
                          : latestDeployment?.phase === 'job_submitted' ||
                              latestDeployment?.phase === 'job_processing' ||
                              latestDeployment?.phase === 'active'
                            ? 'done'
                            : latestDeployment?.phase === 'failed'
                              ? 'error'
                              : 'active'
                      }
                    />
                    <LifecycleStage
                      label="Processing"
                      description="Operator provisioning sidecar + vault"
                      status={
                        latestDeployment?.phase === 'job_submitted' ||
                        latestDeployment?.phase === 'job_processing'
                          ? 'active'
                          : latestDeployment?.phase === 'active'
                            ? 'done'
                            : latestDeployment?.phase === 'failed'
                              ? 'error'
                              : 'pending'
                      }
                    />
                    <LifecycleStage
                      label="Active"
                      description="Agent running, vault deployed"
                      status={
                        latestDeployment?.phase === 'active'
                          ? 'done'
                          : latestDeployment?.phase === 'failed'
                            ? 'error'
                            : 'pending'
                      }
                    />
                  </div>

                  {latestDeployment?.phase === 'failed' && latestDeployment.errorMessage && (
                    <div className="text-sm text-crimson-400 p-3 rounded-lg bg-crimson-500/5 border border-crimson-500/20">
                      {latestDeployment.errorMessage}
                    </div>
                  )}

                  {latestDeployment?.phase === 'active' && (
                    <div className="p-3.5 rounded-lg bg-emerald-700/5 border border-emerald-700/30 dark:bg-emerald-500/5 dark:border-emerald-500/30 space-y-2">
                      <div className="text-sm font-display font-medium text-arena-elements-icon-success">
                        Agent Deployed
                      </div>
                      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm font-data">
                        {latestDeployment.vaultAddress &&
                          latestDeployment.vaultAddress !== zeroAddress && (
                            <>
                              <span className="text-arena-elements-textTertiary">Vault</span>
                              <span className="text-arena-elements-textPrimary truncate">
                                {latestDeployment.vaultAddress}
                              </span>
                            </>
                          )}
                        {latestDeployment.sandboxId && (
                          <>
                            <span className="text-arena-elements-textTertiary">Sandbox</span>
                            <span className="text-arena-elements-textPrimary truncate">
                              {latestDeployment.sandboxId}
                            </span>
                          </>
                        )}
                        {latestDeployment.workflowId != null && (
                          <>
                            <span className="text-arena-elements-textTertiary">Workflow</span>
                            <span className="text-arena-elements-textPrimary">
                              {latestDeployment.workflowId}
                            </span>
                          </>
                        )}
                        {latestDeployment.callId != null && (
                          <>
                            <span className="text-arena-elements-textTertiary">Call ID</span>
                            <span className="text-arena-elements-textPrimary">
                              {latestDeployment.callId}
                            </span>
                          </>
                        )}
                      </div>
                      {latestDeployment.serviceId != null && (
                        <Link
                          to={`/arena/bot/service-${latestDeployment.serviceId}`}
                          className="inline-flex items-center gap-1.5 text-sm font-display font-medium text-violet-700 dark:text-violet-400 hover:underline mt-1"
                        >
                          View Bot &rarr;
                        </Link>
                      )}
                    </div>
                  )}

                  <div className="text-xs font-data text-arena-elements-textTertiary">
                    TX: {txHash}
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={goBack} disabled={!!txHash}>
                Back
              </Button>
              {txHash && !latestDeployment?.phase?.match(/active|failed/) && (
                <span className="text-sm text-arena-elements-textTertiary animate-pulse self-center">
                  Waiting for operator...
                </span>
              )}
              {latestDeployment?.phase === 'active' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    resetTx();
                    setName('');
                    setStep('configure');
                  }}
                >
                  Deploy Another Agent
                </Button>
              )}
              {latestDeployment?.phase === 'failed' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    resetTx();
                    setStep('deploy');
                  }}
                >
                  Try Again
                </Button>
              )}
            </div>
          </>
        )}

        {/* ── Your Deployments (all steps) ───────────────────────────── */}
        {myProvisions.length > 0 && (
          <Card>
            <CardContent className="pt-5 pb-4 space-y-3">
              <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                Your Deployments
              </label>
              <div className="space-y-2">
                {myProvisions.map((prov) => (
                  <div
                    key={prov.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                      prov.phase === 'active'
                        ? 'border-emerald-700/30 bg-emerald-700/5 dark:border-emerald-500/30 dark:bg-emerald-500/5'
                        : prov.phase === 'failed'
                          ? 'border-crimson-500/30 bg-crimson-500/5'
                          : 'border-violet-500/20 bg-violet-500/5'
                    }`}
                  >
                    <div
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${phaseDotClass(prov.phase)}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-display font-medium text-arena-elements-textPrimary truncate">
                          {prov.name}
                        </span>
                        <Badge
                          variant={
                            prov.phase === 'active'
                              ? 'success'
                              : prov.phase === 'failed'
                                ? 'destructive'
                                : 'outline'
                          }
                          className="text-[10px] shrink-0"
                        >
                          {phaseLabel(prov.phase)}
                        </Badge>
                      </div>
                      <div className="text-xs font-data text-arena-elements-textTertiary mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>
                          {strategyPacks.find((p) => p.id === prov.strategyType)?.name ??
                            prov.strategyType}
                        </span>
                        <span>{timeAgo(prov.createdAt)}</span>
                        {prov.callId != null && <span>call #{prov.callId}</span>}
                        {prov.txHash && (
                          <span className="truncate">
                            {prov.txHash.slice(0, 10)}...{prov.txHash.slice(-4)}
                          </span>
                        )}
                      </div>
                    </div>
                    {prov.phase === 'active' && prov.serviceId != null && (
                      <Link
                        to={`/arena/bot/service-${prov.serviceId}`}
                        className="text-xs font-data font-medium text-violet-700 dark:text-violet-400 hover:underline shrink-0"
                      >
                        View
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Advanced Settings Dialog ────────────────────────────────── */}
      <Dialog open={showAdvanced} onOpenChange={setShowAdvanced}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display text-lg">
              Agent Instructions: {selectedPack.name}
            </DialogTitle>
            <DialogDescription className="text-sm">
              This is the full system prompt injected into the sidecar coding agent. The operator
              binary fills in runtime values (API URL, vault address, etc.) at provision time.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="full" className="flex-1 flex flex-col min-h-0">
            <TabsList>
              <TabsTrigger value="full">Full Instructions</TabsTrigger>
              <TabsTrigger value="expert">Expert Knowledge</TabsTrigger>
              <TabsTrigger value="extra">Custom Instructions</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>

            <TabsContent value="full" className="flex-1 mt-3">
              <div className="space-y-3">
                <p className="text-xs text-arena-elements-textSecondary">
                  Read-only. Edit the "Expert Knowledge" tab to modify the strategy section. Values
                  in {'{{'}braces{'}}'} are filled by the operator at runtime.
                </p>
                <pre className="w-full min-h-64 max-h-[50vh] overflow-auto rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed whitespace-pre-wrap">
                  {fullInstructions}
                </pre>
              </div>
            </TabsContent>

            <TabsContent value="expert" className="flex-1 mt-3">
              <div className="space-y-3 p-px">
                <p className="text-xs text-arena-elements-textSecondary">
                  Injected under "Expert Strategy Knowledge". Edit protocol APIs, contracts, or
                  methodology.
                </p>
                <textarea
                  value={customExpertKnowledge || selectedPack.expertKnowledge}
                  onChange={(e) => setCustomExpertKnowledge(e.target.value)}
                  className="w-full min-h-56 max-h-[50vh] rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed focus:outline-none focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/10 transition-all resize-y"
                />
                {customExpertKnowledge && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCustomExpertKnowledge('')}
                    className="text-xs"
                  >
                    Reset to Default
                  </Button>
                )}
              </div>
            </TabsContent>

            <TabsContent value="extra" className="flex-1 mt-3">
              <div className="space-y-3 p-px">
                <p className="text-xs text-arena-elements-textSecondary">
                  Additional instructions appended to the agent profile.
                </p>
                <textarea
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  className="w-full min-h-40 max-h-[50vh] rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed focus:outline-none focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/10 transition-all resize-y"
                  placeholder={`Examples:\n- Only trade ETH/USDC pairs\n- Max position: 5% of portfolio\n- Focus on Asian session hours\n- Avoid news events`}
                />
              </div>
            </TabsContent>

            <TabsContent value="settings" className="flex-1 mt-3">
              <div className="space-y-5 p-px">
                <div>
                  <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Cron Schedule
                  </label>
                  <Input
                    value={customCron || selectedPack.cron}
                    onChange={(e) => setCustomCron(e.target.value)}
                    className="font-data"
                  />
                  <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                    6-field cron. Default: {selectedPack.cron} = every{' '}
                    {cronToHuman(selectedPack.cron)}
                  </p>
                </div>
                <div>
                  <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Max Turns Per Iteration
                  </label>
                  <Input
                    type="number"
                    min="1"
                    max="50"
                    value={customMaxTurns || String(selectedPack.maxTurns)}
                    onChange={(e) => setCustomMaxTurns(e.target.value)}
                    className="font-data max-w-28"
                  />
                </div>
                <div>
                  <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Timeout
                  </label>
                  <span className="text-sm font-data text-arena-elements-textPrimary">
                    {selectedPack.timeoutMs / 1000}s per iteration
                  </span>
                </div>
                <div>
                  <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Providers
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedPack.providers.map((p) => (
                      <span
                        key={p}
                        className="text-xs font-data px-2 py-1 rounded bg-violet-500/10 text-violet-700 dark:text-violet-400"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
                {(customCron || customMaxTurns) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCustomCron('');
                      setCustomMaxTurns('');
                    }}
                    className="text-xs"
                  >
                    Reset to Defaults
                  </Button>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Lifecycle Stage Component ────────────────────────────────────────────

function LifecycleStage({
  label,
  description,
  status,
}: {
  label: string;
  description: string;
  status: 'pending' | 'active' | 'done' | 'error';
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={`w-3 h-3 rounded-full shrink-0 ${
          status === 'done'
            ? 'bg-arena-elements-icon-success'
            : status === 'active'
              ? 'bg-amber-400 animate-pulse'
              : status === 'error'
                ? 'bg-crimson-400'
                : 'bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border border-arena-elements-borderColor'
        }`}
      />
      <div>
        <div
          className={`text-sm font-display font-medium ${
            status === 'done'
              ? 'text-arena-elements-icon-success'
              : status === 'active'
                ? 'text-amber-600 dark:text-amber-400'
                : status === 'error'
                  ? 'text-crimson-400'
                  : 'text-arena-elements-textTertiary'
          }`}
        >
          {label}
        </div>
        <div className="text-xs font-data text-arena-elements-textTertiary">{description}</div>
      </div>
    </div>
  );
}
