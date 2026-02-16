import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useWatchContractEvent } from 'wagmi';
import { encodeAbiParameters, parseAbiParameters, zeroAddress, formatEther } from 'viem';
import type { Address } from 'viem';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '~/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '~/components/ui/tabs';
import { Identicon } from '~/components/shared/Identicon';
import { toast } from 'sonner';
import { tangleServicesAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { tangleLocal } from '~/lib/contracts/chains';
import { useOperators } from '~/lib/hooks/useOperators';
import { useQuotes, type OperatorQuote } from '~/lib/hooks/useQuotes';
import { addTx } from '~/lib/stores/txHistory';

export const meta: MetaFunction = () => [
  { title: 'Deploy Agent — AI Trading Arena' },
];

// ── Full sidecar agent template (from build_profile_instructions) ────────

/** Build the complete agent instructions that get injected into the sidecar.
 *  Mirrors trading-blueprint-lib/src/prompts/packs.rs:build_profile_instructions().
 *  Placeholders like {{api_url}} are filled by the operator binary at provision time. */
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

// ── Strategy Pack definitions (mirrors Rust StrategyPack) ────────────────

interface StrategyPackDef {
  id: string;
  name: string;
  providers: string[];
  description: string;
  cron: string;
  maxTurns: number;
  timeoutMs: number;
  /** Strategy-specific expert knowledge injected into the "Expert Strategy Knowledge" section */
  expertKnowledge: string;
}

const strategyPacks: StrategyPackDef[] = [
  {
    id: 'dex',
    name: 'DEX Spot Trading',
    providers: ['Uniswap V3', 'CoinGecko'],
    description: 'Spot trading on decentralized exchanges. Discovers pools, tracks prices, executes swaps.',
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
    description: 'Trades implied vs realized volatility using funding rates and prediction markets.',
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

// ── Deployment status ────────────────────────────────────────────────────

type DeploymentPhase = 'idle' | 'quoting' | 'deploying' | 'active';

function DeploymentTracker({ phase }: { phase: DeploymentPhase }) {
  if (phase === 'idle') return null;
  const steps = [
    { key: 'quoting', label: 'Fetching Quotes' },
    { key: 'deploying', label: 'Deploying' },
    { key: 'active', label: 'Active' },
  ];
  const idx = steps.findIndex((s) => s.key === phase);
  return (
    <div className="flex items-center gap-3 py-2">
      {steps.map((step, i) => (
        <div key={step.key} className="flex items-center gap-2">
          {i > 0 && <div className={`w-6 h-px ${i <= idx ? 'bg-violet-500/40' : 'bg-arena-elements-borderColor'}`} />}
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${
              i <= idx
                ? i === idx && phase !== 'active' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
                : 'bg-arena-elements-borderColor'
            }`} />
            <span className={`text-xs font-data ${i <= idx ? 'text-arena-elements-textSecondary' : 'text-arena-elements-textTertiary'}`}>
              {step.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────

export default function ProvisionPage() {
  const { address: userAddress, isConnected } = useAccount();

  const [name, setName] = useState('');
  const [strategyType, setStrategyType] = useState('dex');
  const [selectedOperators, setSelectedOperators] = useState<Set<Address>>(new Set());
  const [manualOperator, setManualOperator] = useState('');
  const [blueprintId, setBlueprintId] = useState(import.meta.env.VITE_BLUEPRINT_ID ?? '0');

  // Advanced overrides
  const [customInstructions, setCustomInstructions] = useState('');
  const [customExpertKnowledge, setCustomExpertKnowledge] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [customMaxTurns, setCustomMaxTurns] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Deployment
  const [deploymentPhase, setDeploymentPhase] = useState<DeploymentPhase>('idle');

  const { operators: discoveredOperators, isLoading: isDiscovering, error: operatorError, operatorCount } = useOperators(
    BigInt(blueprintId || '0'),
  );
  const { writeContract, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  // Resolve selected operators to DiscoveredOperator objects (for useQuotes).
  // Memoize to avoid new array reference every render (would re-trigger useQuotes effect).
  const selectedOps = useMemo(
    () => discoveredOperators.filter((op) => selectedOperators.has(op.address)),
    [discoveredOperators, selectedOperators],
  );
  const quotesEnabled = selectedOperators.size > 0 && deploymentPhase === 'quoting';
  const ttlBlocks = useMemo(() => BigInt(30 * 86400 / 12), []); // ~30 days at 12s/block
  const blueprintIdBig = useMemo(() => BigInt(blueprintId || '0'), [blueprintId]);
  const {
    quotes, isLoading: isQuoting, errors: quoteErrors, totalCost, refetch: refetchQuotes,
  } = useQuotes(selectedOps, blueprintIdBig, ttlBlocks, quotesEnabled);

  // Watch ServiceActivated — quote-based creation fires this directly (no requestId step)
  useWatchContractEvent({
    address: addresses.tangle, abi: tangleServicesAbi, eventName: 'ServiceActivated',
    onLogs(logs) {
      for (const log of logs) {
        if (log.args.blueprintId === BigInt(blueprintId || '0')) {
          setDeploymentPhase('active');
          toast.success('Service is now active!');
        }
      }
    },
    enabled: deploymentPhase === 'deploying',
  });

  useEffect(() => { setCustomExpertKnowledge(''); setCustomInstructions(''); setCustomCron(''); setCustomMaxTurns(''); }, [strategyType]);
  useEffect(() => { if (txHash) addTx(txHash, `Deploy ${name || 'Agent'} (${selectedPack?.name})`, tangleLocal.id); }, [txHash]);
  useEffect(() => { if (isSuccess) { setDeploymentPhase('deploying'); toast.success('Service deployment tx confirmed!'); } }, [isSuccess]);
  useEffect(() => { if (error) toast.error(`Transaction failed: ${error.message.slice(0, 120)}`); }, [error]);

  // Auto-trigger quoting when operators are selected
  useEffect(() => {
    if (selectedOperators.size > 0 && deploymentPhase === 'idle') {
      setDeploymentPhase('quoting');
    } else if (selectedOperators.size === 0 && deploymentPhase === 'quoting') {
      setDeploymentPhase('idle');
    }
  }, [selectedOperators.size, deploymentPhase]);

  const selectedPack = strategyPacks.find((p) => p.id === strategyType)!;
  const effectiveExpert = customExpertKnowledge || selectedPack.expertKnowledge;
  const effectiveCron = customCron || selectedPack.cron;
  const effectiveMaxTurns = customMaxTurns ? Number(customMaxTurns) : selectedPack.maxTurns;
  const fullInstructions = buildFullInstructions(effectiveExpert, strategyType);

  const toggleOperator = useCallback((addr: Address) => {
    setSelectedOperators((prev) => { const n = new Set(prev); if (n.has(addr)) n.delete(addr); else n.add(addr); return n; });
  }, []);

  const addManualOperator = useCallback(() => {
    const t = manualOperator.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(t)) { setSelectedOperators((prev) => new Set(prev).add(t as Address)); setManualOperator(''); }
    else toast.error('Invalid address');
  }, [manualOperator]);

  const handleSubmit = () => {
    if (!isConnected || !userAddress) { toast.error('Connect wallet first'); return; }
    if (!name.trim()) { toast.error('Enter agent name'); return; }
    if (quotes.length === 0) { toast.error('No quotes available — fetch quotes first'); return; }

    const strategyConfig: Record<string, unknown> = {};
    if (customExpertKnowledge) strategyConfig.expert_knowledge_override = customExpertKnowledge;
    if (customInstructions) strategyConfig.custom_instructions = customInstructions;

    const config = encodeAbiParameters(
      parseAbiParameters('string, string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[]'),
      [name, strategyType, JSON.stringify(strategyConfig), '{}', '{}', zeroAddress,
        (import.meta.env.VITE_USDC_ADDRESS ?? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') as Address,
        [userAddress], 1n, 1n, '', effectiveCron, 2n, 2048n, 30n, []],
    );

    // Use requestService — createServiceFromQuotes is not available on older Tangle snapshots
    const operatorAddresses = quotes.map((q) => q.operator);

    writeContract({
      address: addresses.tangle, abi: tangleServicesAbi, functionName: 'requestService',
      chainId: tangleLocal.id,
      args: [
        BigInt(blueprintId),
        operatorAddresses,
        config,
        [userAddress],
        BigInt(30 * 86400),
        zeroAddress,       // paymentToken (native ETH)
        totalCost,         // paymentAmount
      ],
      value: totalCost,
    });
  };

  const discoveredAddrs = new Set(discoveredOperators.map((o) => o.address.toLowerCase()));
  const manualAddrs = Array.from(selectedOperators).filter((a) => !discoveredAddrs.has(a.toLowerCase()));

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-arena-elements-textTertiary hover:text-violet-700 dark:hover:text-violet-400 mb-6 font-display font-medium transition-colors">
        <span>&larr;</span> Leaderboard
      </Link>

      <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">Deploy Trading Agent</h1>
      <p className="text-base text-arena-elements-textSecondary mb-8">
        Choose a strategy, customize the agent profile, select operators.
      </p>

      <div className="space-y-5">
        {/* Name */}
        <Card>
          <CardContent className="pt-5 pb-4">
            <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">Agent Name</label>
            <Input placeholder="e.g. Alpha DEX Bot" value={name} onChange={(e) => setName(e.target.value)} />
          </CardContent>
        </Card>

        {/* Strategy */}
        <Card>
          <CardContent className="pt-5 pb-5 space-y-4">
            <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">Strategy Profile</label>
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
                        : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-2'
                    }`}
                  >
                    <div className={`text-sm font-display font-semibold mb-0.5 ${active ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}>
                      {p.name}
                    </div>
                    <div className="text-xs font-data text-arena-elements-textTertiary leading-snug line-clamp-2">
                      {p.providers.slice(0, 3).join(', ')}{p.providers.length > 3 ? ` +${p.providers.length - 3}` : ''}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between pt-1">
              <p className="text-sm text-arena-elements-textSecondary leading-relaxed max-w-lg">
                {selectedPack.description}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowAdvanced(true)} className="text-sm shrink-0 ml-4">
                Customize
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Operators */}
        <Card>
          <CardContent className="pt-5 pb-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">Operators</label>
              <div className="flex items-center gap-2.5">
                <label className="text-xs font-data text-arena-elements-textSecondary">Blueprint</label>
                <Input type="number" min="0" value={blueprintId} onChange={(e) => setBlueprintId(e.target.value)} className="w-20 h-9 text-sm" />
              </div>
            </div>

            {operatorCount > 0n && (
              <p className="text-xs text-arena-elements-textSecondary">{operatorCount.toString()} registered for blueprint {blueprintId}</p>
            )}

            {isDiscovering ? (
              <div className="text-sm text-arena-elements-textTertiary py-4 text-center animate-pulse">Discovering operators...</div>
            ) : operatorError ? (
              <div className="text-sm text-crimson-400 py-3">Error: {operatorError.message.slice(0, 80)}</div>
            ) : discoveredOperators.length > 0 ? (
              <div className="grid gap-2">
                {discoveredOperators.map((op) => {
                  const sel = selectedOperators.has(op.address);
                  return (
                    <button key={op.address} type="button" onClick={() => toggleOperator(op.address)}
                      className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                        sel ? 'border-violet-500/40 bg-violet-500/5' : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/30'}`}>
                      <Identicon address={op.address} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="font-data text-sm truncate">{op.address}</div>
                        {op.rpcAddress && <div className="text-xs text-arena-elements-textTertiary truncate mt-0.5">{op.rpcAddress}</div>}
                      </div>
                      {sel && <Badge variant="success" className="text-xs">Selected</Badge>}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-arena-elements-textTertiary py-3">
                No operators found for blueprint {blueprintId}.
                {operatorCount === 0n && <span className="block text-xs mt-1">Count is 0 on-chain.</span>}
              </div>
            )}

            {manualAddrs.length > 0 && (
              <div className="grid gap-2">
                {manualAddrs.map((addr) => (
                  <div key={addr} className="flex items-center gap-3 p-3 rounded-lg border border-violet-500/40 bg-violet-500/5">
                    <Identicon address={addr} size={28} />
                    <div className="font-data text-sm truncate flex-1">{addr}</div>
                    <button type="button" onClick={() => toggleOperator(addr)} className="text-xs text-arena-elements-textTertiary hover:text-crimson-400">Remove</button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input placeholder="0x..." value={manualOperator} onChange={(e) => setManualOperator(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addManualOperator()} />
              <Button type="button" variant="outline" size="sm" onClick={addManualOperator} className="text-sm shrink-0">Add</Button>
            </div>
          </CardContent>
        </Card>

        {/* Quotes */}
        {selectedOperators.size > 0 && (
          <Card>
            <CardContent className="pt-5 pb-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">Operator Quotes</label>
                <Button type="button" variant="outline" size="sm" onClick={() => { setDeploymentPhase('quoting'); refetchQuotes(); }}
                  disabled={isQuoting} className="text-xs">
                  {isQuoting ? 'Fetching...' : 'Refresh Quotes'}
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
                    <div key={q.operator} className="flex items-center gap-3 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
                      <Identicon address={q.operator} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="font-data text-sm truncate">{q.operator}</div>
                        <div className="text-xs text-arena-elements-textTertiary mt-0.5">
                          Expires in {Math.max(0, Number(q.details.expiry) - Math.floor(Date.now() / 1000))}s
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-data text-sm text-arena-elements-icon-success">
                          {formatEther(q.totalCost)} ETH
                        </div>
                        <div className="text-xs text-arena-elements-textTertiary">
                          ${q.costRate.toFixed(6)}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-1 px-1">
                    <span className="text-xs font-data text-arena-elements-textSecondary">Total Cost</span>
                    <span className="font-data text-sm font-semibold text-arena-elements-textPrimary">
                      {formatEther(totalCost)} ETH
                    </span>
                  </div>
                </div>
              )}

              {quoteErrors.size > 0 && (
                <div className="space-y-1">
                  {Array.from(quoteErrors.entries()).map(([addr, msg]) => (
                    <div key={addr} className="flex items-center gap-2 text-xs text-crimson-400">
                      <Identicon address={addr} size={16} />
                      <span className="truncate">{addr.slice(0, 10)}...{addr.slice(-6)}: {msg}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Submit */}
        <Card>
          <CardContent className="pt-5 pb-4">
            {name.trim() && selectedOperators.size > 0 && (
              <div className="mb-4 p-3.5 rounded-lg bg-arena-elements-item-backgroundHover/30 border border-arena-elements-borderColor/40">
                <div className="grid grid-cols-2 gap-y-1 text-sm font-data">
                  <span className="text-arena-elements-textTertiary">Agent</span><span className="text-arena-elements-textPrimary">{name}</span>
                  <span className="text-arena-elements-textTertiary">Strategy</span><span className="text-arena-elements-textPrimary">{selectedPack.name}</span>
                  <span className="text-arena-elements-textTertiary">Frequency</span><span className="text-arena-elements-textPrimary">Every {cronToHuman(effectiveCron)}</span>
                  <span className="text-arena-elements-textTertiary">Operators</span><span className="text-arena-elements-textPrimary">{quotes.length} quoted</span>
                  {totalCost > 0n && (
                    <><span className="text-arena-elements-textTertiary">Cost</span><span className="text-arena-elements-icon-success">{formatEther(totalCost)} ETH</span></>
                  )}
                  {(customExpertKnowledge || customInstructions) && (
                    <><span className="text-arena-elements-textTertiary">Custom</span><span className="text-amber-600 dark:text-amber-400">Modified</span></>
                  )}
                </div>
              </div>
            )}

            {deploymentPhase !== 'idle' && deploymentPhase !== 'quoting' && (
              <div className="mb-4 p-3.5 rounded-lg bg-violet-500/5 border border-violet-500/20">
                <DeploymentTracker phase={deploymentPhase} />
                {txHash && <p className="text-xs font-data text-arena-elements-textTertiary break-all mt-2">tx: {txHash}</p>}
              </div>
            )}

            <Button onClick={handleSubmit} className="w-full" size="lg"
              disabled={!isConnected || isPending || isConfirming || isQuoting || !name.trim() || quotes.length === 0}>
              {!isConnected ? 'Connect Wallet'
                : isPending ? 'Confirm in Wallet...'
                : isConfirming ? 'Confirming...'
                : isQuoting ? 'Waiting for Quotes...'
                : quotes.length === 0 ? 'Select Operators to Get Quotes'
                : `Deploy ${selectedPack.name} (${formatEther(totalCost)} ETH)`}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* ── Advanced Settings Dialog ────────────────────────────────── */}
      <Dialog open={showAdvanced} onOpenChange={setShowAdvanced}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display text-lg">Agent Instructions: {selectedPack.name}</DialogTitle>
            <DialogDescription className="text-sm">
              This is the full system prompt injected into the sidecar coding agent. The operator binary fills in runtime values (API URL, vault address, etc.) at provision time.
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
                  Read-only. Edit the "Expert Knowledge" tab to modify the strategy section.
                  Values in {'{{'}braces{'}}'}  are filled by the operator at runtime.
                </p>
                <pre className="w-full min-h-64 max-h-[50vh] overflow-auto rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed whitespace-pre-wrap">
                  {fullInstructions}
                </pre>
              </div>
            </TabsContent>

            <TabsContent value="expert" className="flex-1 mt-3">
              <div className="space-y-3 p-px">
                <p className="text-xs text-arena-elements-textSecondary">
                  Injected under "Expert Strategy Knowledge". Edit protocol APIs, contracts, or methodology.
                </p>
                <textarea
                  value={customExpertKnowledge || selectedPack.expertKnowledge}
                  onChange={(e) => setCustomExpertKnowledge(e.target.value)}
                  className="w-full min-h-56 max-h-[50vh] rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed focus:outline-none focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/10 transition-all resize-y"
                />
                {customExpertKnowledge && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setCustomExpertKnowledge('')} className="text-xs">Reset to Default</Button>
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
                  <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">Cron Schedule</label>
                  <Input value={customCron || selectedPack.cron} onChange={(e) => setCustomCron(e.target.value)} className="font-data" />
                  <p className="text-xs text-arena-elements-textTertiary mt-1.5">6-field cron. Default: {selectedPack.cron} = every {cronToHuman(selectedPack.cron)}</p>
                </div>
                <div>
                  <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">Max Turns Per Iteration</label>
                  <Input type="number" min="1" max="50" value={customMaxTurns || String(selectedPack.maxTurns)}
                    onChange={(e) => setCustomMaxTurns(e.target.value)} className="font-data max-w-28" />
                </div>
                <div>
                  <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">Timeout</label>
                  <span className="text-sm font-data text-arena-elements-textPrimary">{selectedPack.timeoutMs / 1000}s per iteration</span>
                </div>
                <div>
                  <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">Providers</label>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedPack.providers.map((p) => (
                      <span key={p} className="text-xs font-data px-2 py-1 rounded bg-violet-500/10 text-violet-700 dark:text-violet-400">{p}</span>
                    ))}
                  </div>
                </div>
                {(customCron || customMaxTurns) && (
                  <Button type="button" variant="outline" size="sm" onClick={() => { setCustomCron(''); setCustomMaxTurns(''); }} className="text-xs">Reset to Defaults</Button>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function cronToHuman(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length < 6) return cron;
  const min = parts[1];
  if (min.startsWith('*/')) { const n = parseInt(min.slice(2)); return n === 1 ? '1 min' : `${n} min`; }
  return cron;
}
