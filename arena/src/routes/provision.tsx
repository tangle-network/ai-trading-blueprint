import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi';
import { encodeAbiParameters, parseAbiParameters, zeroAddress, parseEther } from 'viem';
import type { Address } from 'viem';
import { AnimatedPage } from '~/components/motion/AnimatedPage';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { toast } from 'sonner';
import { tangleServicesAbi, tradingBlueprintAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';

export const meta: MetaFunction = () => [
  { title: 'Provision Bot — AI Trading Arena' },
];

const strategyOptions = [
  { value: 'dex-momentum', label: 'DEX Momentum', desc: 'Trend-following on DEX pairs' },
  { value: 'dex-mean-reversion', label: 'Mean Reversion', desc: 'Buy dips, sell rallies' },
  { value: 'dex-arbitrage', label: 'DEX Arbitrage', desc: 'Cross-DEX price discrepancies' },
  { value: 'defi-yield', label: 'DeFi Yield', desc: 'Automated yield farming' },
  { value: 'prediction-market', label: 'Prediction Markets', desc: 'Polymarket/event-driven' },
];

export default function ProvisionPage() {
  const { address: userAddress, isConnected } = useAccount();

  // Form state
  const [name, setName] = useState('');
  const [strategyType, setStrategyType] = useState('dex-momentum');
  const [operators, setOperators] = useState('');
  const [assetToken, setAssetToken] = useState('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'); // USDC
  const [cpuCores, setCpuCores] = useState('2');
  const [memoryMb, setMemoryMb] = useState('2048');
  const [lifetimeDays, setLifetimeDays] = useState('30');
  const [tradingCron, setTradingCron] = useState('0 */4 * * *');
  const [blueprintId, setBlueprintId] = useState(import.meta.env.VITE_BLUEPRINT_ID ?? '0');

  // Estimate cost from contract
  const { data: estimatedCost } = useReadContract({
    address: addresses.tradingBlueprint,
    abi: tradingBlueprintAbi,
    functionName: 'estimateProvisionCost',
    args: [BigInt(lifetimeDays || '0'), BigInt(cpuCores || '0'), BigInt(memoryMb || '0')],
    query: {
      enabled: addresses.tradingBlueprint !== zeroAddress,
    },
  });

  // Submit service request
  const { writeContract, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) {
      toast.success('Service request submitted! Waiting for operator approval...');
    }
  }, [isSuccess]);

  useEffect(() => {
    if (error) {
      toast.error(`Transaction failed: ${error.message.slice(0, 120)}`);
    }
  }, [error]);

  const handleSubmit = () => {
    if (!isConnected || !userAddress) {
      toast.error('Connect your wallet first');
      return;
    }
    if (!name.trim()) {
      toast.error('Enter a bot name');
      return;
    }

    // ABI-encode the TradingProvisionRequest as the service config
    const config = encodeAbiParameters(
      parseAbiParameters('string, string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[]'),
      [
        name,                              // name
        strategyType,                      // strategy_type
        '{}',                              // strategy_config_json
        '{}',                              // risk_params_json
        '{}',                              // env_json
        zeroAddress,                       // factory_address (set by blueprint)
        assetToken as Address,             // asset_token
        [userAddress],                     // signers
        1n,                                // required_signatures
        1n,                                // chain_id (set by blueprint)
        '',                                // rpc_url (set by blueprint)
        tradingCron,                       // trading_loop_cron
        BigInt(cpuCores),                  // cpu_cores
        BigInt(memoryMb),                  // memory_mb
        BigInt(lifetimeDays),              // max_lifetime_days
        [],                                // validator_service_ids
      ],
    );

    const operatorAddrs = operators.split(',')
      .map(s => s.trim())
      .filter(s => /^0x[a-fA-F0-9]{40}$/.test(s)) as Address[];

    if (operatorAddrs.length === 0) {
      toast.error('Enter at least one valid operator address');
      return;
    }

    writeContract({
      address: addresses.tangle,
      abi: tangleServicesAbi,
      functionName: 'requestService',
      args: [
        BigInt(blueprintId),     // blueprintId
        operatorAddrs,           // operators
        config,                  // config (ABI-encoded TradingProvisionRequest)
        [userAddress],           // permittedCallers (self)
        BigInt(Number(lifetimeDays) * 86400), // ttl in seconds
        zeroAddress,             // paymentToken (native ETH)
        estimatedCost ?? 0n,     // paymentAmount
      ],
      value: estimatedCost ?? 0n,
    });
  };

  return (
    <AnimatedPage>
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8">
        <Link
          to="/arena"
          className="inline-flex items-center gap-1.5 text-sm text-arena-elements-textTertiary hover:text-emerald-400 mb-6 transition-colors duration-200 font-display font-medium"
        >
          <span className="text-xs">&larr;</span> Back to Arena
        </Link>

        <div className="mb-8">
          <h1 className="font-display font-bold text-3xl tracking-tight">Deploy Trading Bot</h1>
          <p className="text-arena-elements-textSecondary mt-1">
            Provision an AI trading agent on Tangle Network.
          </p>
        </div>

        <div className="space-y-6">
          {/* Bot Identity */}
          <Card>
            <CardHeader>
              <CardTitle>Bot Identity</CardTitle>
              <CardDescription>Name and strategy for your trading agent.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                  Bot Name
                </label>
                <Input
                  placeholder="e.g. Alpha Momentum V2"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                  Strategy
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {strategyOptions.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setStrategyType(opt.value)}
                      className={`text-left p-3 rounded-lg border transition-all duration-200 ${
                        strategyType === opt.value
                          ? 'border-emerald-500/40 bg-emerald-500/5'
                          : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/30'
                      }`}
                    >
                      <div className="font-display font-medium text-sm">{opt.label}</div>
                      <div className="text-[11px] text-arena-elements-textTertiary mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Infrastructure */}
          <Card>
            <CardHeader>
              <CardTitle>Infrastructure</CardTitle>
              <CardDescription>Resources and runtime configuration.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-3 gap-4">
                <div>
                  <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                    CPU Cores
                  </label>
                  <Input type="number" min="1" max="8" value={cpuCores} onChange={(e) => setCpuCores(e.target.value)} />
                </div>
                <div>
                  <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                    Memory (MB)
                  </label>
                  <Input type="number" min="512" max="16384" step="512" value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} />
                </div>
                <div>
                  <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                    Lifetime (Days)
                  </label>
                  <Input type="number" min="1" max="365" value={lifetimeDays} onChange={(e) => setLifetimeDays(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                  Trading Loop Cron
                </label>
                <Input
                  placeholder="0 */4 * * *"
                  value={tradingCron}
                  onChange={(e) => setTradingCron(e.target.value)}
                />
                <p className="text-[10px] text-arena-elements-textTertiary mt-1">
                  How often the AI agent evaluates trades. Default: every 4 hours.
                </p>
              </div>
              <div>
                <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                  Asset Token
                </label>
                <Input
                  placeholder="0x..."
                  value={assetToken}
                  onChange={(e) => setAssetToken(e.target.value)}
                />
                <p className="text-[10px] text-arena-elements-textTertiary mt-1">
                  The base token for the vault (e.g. USDC).
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Operators */}
          <Card>
            <CardHeader>
              <CardTitle>Operators</CardTitle>
              <CardDescription>Which Tangle operators will run this bot.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                  Operator Addresses (comma-separated)
                </label>
                <Input
                  placeholder="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
                  value={operators}
                  onChange={(e) => setOperators(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2 block">
                  Blueprint ID
                </label>
                <Input
                  type="number"
                  min="0"
                  value={blueprintId}
                  onChange={(e) => setBlueprintId(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          {/* Cost & Submit */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-6">
                <span className="text-sm text-arena-elements-textSecondary font-display">Estimated Cost</span>
                <div className="flex items-center gap-2">
                  {estimatedCost != null ? (
                    <span className="font-data font-bold text-lg">
                      {Number(estimatedCost) / 1e18} ETH
                    </span>
                  ) : (
                    <span className="font-data text-arena-elements-textTertiary">—</span>
                  )}
                </div>
              </div>

              {isSuccess && txHash && (
                <div className="mb-4 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="success">Submitted</Badge>
                  </div>
                  <p className="text-xs font-data text-arena-elements-textSecondary break-all">
                    tx: {txHash}
                  </p>
                </div>
              )}

              <Button
                onClick={handleSubmit}
                className="w-full"
                size="lg"
                disabled={!isConnected || isPending || isConfirming || !name.trim()}
              >
                {!isConnected
                  ? 'Connect Wallet'
                  : isPending
                  ? 'Confirm in Wallet...'
                  : isConfirming
                  ? 'Confirming...'
                  : 'Deploy Bot'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </AnimatedPage>
  );
}
