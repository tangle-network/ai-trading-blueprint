import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { MetaFunction } from 'react-router';
import {
  useAccount,
  useWriteContract,
  useSwitchChain,
} from 'wagmi';
import { useStore } from '@nanostores/react';
import { encodeAbiParameters, parseAbiParameters, zeroAddress } from 'viem';
import type { Address } from 'viem';
import {
  Badge, Button, Card, CardContent, Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, Identicon, Input, Tabs, TabsList, TabsTrigger, TabsContent,
} from '@tangle/blueprint-ui/components';
import { toast } from 'sonner';
import { tangleJobsAbi, tangleServicesAbi, tradingBlueprintAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { networks } from '~/lib/contracts/chains';
import { publicClient, selectedChainIdStore, useOperators } from '@tangle/blueprint-ui';
import { useQuotes } from '~/lib/hooks/useQuotes';
import { addTx } from '@tangle/blueprint-ui';
import {
  provisionsForOwner,
  addProvision,
  updateProvision,
  type ProvisionPhase,
  type TrackedProvision,
} from '~/lib/stores/provisions';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import {
  AI_PROVIDERS,
  buildEnvForProvider,
  ACTIVATION_LABELS,
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_API_KEY,
  type AiProvider,
} from '~/lib/config/aiProviders';
import {
  TRADING_BLUEPRINTS,
  getBlueprint,
  strategyPacks,
  buildFullInstructions,
  type TradingBlueprintDef,
  type StrategyPackDef,
} from '~/lib/blueprints';
import { BlueprintSelector } from '~/components/provision/BlueprintSelector';
import { resolveBotId as resolveBot } from '~/lib/utils/resolveBotId';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

export const meta: MetaFunction = () => [
  { title: 'Deploy Agent — AI Trading Arena' },
];

// buildFullInstructions, StrategyPackDef, and strategyPacks extracted to ~/lib/blueprints.

// ── Wizard helpers ───────────────────────────────────────────────────────

type WizardStep = 'blueprint' | 'configure' | 'deploy' | 'secrets';

const STEP_ORDER: WizardStep[] = ['blueprint', 'configure', 'deploy', 'secrets'];
const STEP_LABELS: Record<WizardStep, string> = {
  blueprint: 'Blueprint',
  configure: 'Configure',
  deploy: 'Provision',
  secrets: 'Activate',
};

/** Maps Rust provision progress phases to human-readable labels */
const PROVISION_PROGRESS_LABELS: Record<string, string> = {
  queued: 'Preparing environment...',
  image_pull: 'Pulling container image...',
  container_create: 'Launching container (this may take 10-30s)...',
  container_start: 'Container ready, finalizing configuration...',
  health_check: 'Saving bot configuration...',
  ready: 'Submitting on-chain result...',
};

function phaseLabel(phase: ProvisionPhase): string {
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

function phaseDotClass(phase: ProvisionPhase): string {
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
  blueprintMismatch: boolean;
}

interface DiscoveredService {
  serviceId: number;
  isActive: boolean;
  isPermitted: boolean;
  isOwner: boolean;
  owner: Address;
  operatorCount: number;
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

    // Use wagmi's switchChainAsync which handles add+switch through the connector
    try {
      await switchChainAsync({ chainId: targetChain.id });
      return true;
    } catch (err: any) {
      if (err?.code === 4001) return false; // user rejected
      toast.error(`Switch to ${targetChain.name} in your wallet (chain ${targetChain.id})`);
      return false;
    }
  }, [isConnected, walletChainId, switchChainAsync]);

  // URL param for pre-selecting a blueprint (e.g. ?blueprint=trading-instance)
  const [searchParams] = useSearchParams();
  const preselectedBlueprintId = searchParams.get('blueprint');

  // Blueprint selection state — skip Step 0 if only one blueprint or pre-selected
  const initialBlueprint = preselectedBlueprintId
    ? getBlueprint(preselectedBlueprintId) ?? TRADING_BLUEPRINTS[0]
    : TRADING_BLUEPRINTS.length === 1
      ? TRADING_BLUEPRINTS[0]
      : undefined;
  const skipBlueprintStep = TRADING_BLUEPRINTS.length <= 1 || !!preselectedBlueprintId;

  // Wizard navigation
  const [step, setStep] = useState<WizardStep>(skipBlueprintStep ? 'configure' : 'blueprint');
  const [selectedBlueprint, setSelectedBlueprint] = useState<TradingBlueprintDef | undefined>(initialBlueprint);

  // Blueprint + service defaults (advanced)
  const [blueprintId, setBlueprintId] = useState(
    () => selectedBlueprint?.blueprintId ?? import.meta.env.VITE_BLUEPRINT_ID ?? '0',
  );
  const [serviceMode, setServiceMode] = useState<'existing' | 'new'>('existing');
  const [serviceId, setServiceId] = useState(() => {
    const raw = import.meta.env.VITE_SERVICE_IDS ?? '';
    const first = raw.split(',')[0].trim();
    return first && /^\d+$/.test(first) ? first : '0';
  });
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [showInfra, setShowInfra] = useState(false);
  const [discoveredServices, setDiscoveredServices] = useState<DiscoveredService[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);

  // New service deployment
  const [selectedOperators, setSelectedOperators] = useState<Set<Address>>(new Set());
  const [manualOperator, setManualOperator] = useState('');
  const [newServiceTxHash, setNewServiceTxHash] = useState<`0x${string}` | undefined>();
  const [newServiceDeploying, setNewServiceDeploying] = useState(false);

  // Instance auto-provision state
  const [instanceProvisioning, setInstanceProvisioning] = useState(false);
  const [instanceProvisionError, setInstanceProvisionError] = useState<string | null>(null);

  // Configure — agent settings
  const [name, setName] = useState('');
  const [strategyType, setStrategyType] = useState('dex');
  const [customInstructions, setCustomInstructions] = useState('');
  const [customExpertKnowledge, setCustomExpertKnowledge] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validatorMode, setValidatorMode] = useState<'default' | 'custom'>('default');
  const [customValidatorIds, setCustomValidatorIds] = useState('');

  // Step 4 — deploy
  const { writeContract, data: txHash, isPending, reset: resetTx } =
    useWriteContract();

  // Provisions store
  const ownerProvisions = useMemo(() => provisionsForOwner(userAddress), [userAddress]);
  const myProvisions = useStore(ownerProvisions) as TrackedProvision[];

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
    isPending: isNewServicePending,
  } = useWriteContract();

  // Secrets step state
  const defaultProvider = (DEFAULT_AI_PROVIDER === 'zai' ? 'zai' : 'anthropic') as AiProvider;
  const [aiProvider, setAiProvider] = useState<AiProvider>(defaultProvider);
  const [apiKey, setApiKey] = useState(DEFAULT_AI_API_KEY);
  const [extraEnvs, setExtraEnvs] = useState<{ id: number; key: string; value: string }[]>([]);
  const envIdRef = useRef(0);
  const [isSubmittingSecrets, setIsSubmittingSecrets] = useState(false);
  const [activationPhase, setActivationPhase] = useState<string | null>(null);
  const [secretsLookupError, setSecretsLookupError] = useState<string | null>(null);
  const operatorAuth = useOperatorAuth(OPERATOR_API_URL);

  const selectedPack = strategyPacks.find((p) => p.id === strategyType)!;
  const effectiveExpert = customExpertKnowledge || selectedPack.expertKnowledge;
  const effectiveCron = customCron || selectedPack.cron;
  const fullInstructions = buildFullInstructions(effectiveExpert, strategyType);

  // Reset customizations when strategy changes (computed during render)
  const prevStrategyRef = useRef(strategyType);
  if (prevStrategyRef.current !== strategyType) {
    prevStrategyRef.current = strategyType;
    setCustomExpertKnowledge('');
    setCustomInstructions('');
    setCustomCron('');
  }

  // Determine if the current blueprint is an instance (non-fleet) variant
  const isInstance = selectedBlueprint ? !selectedBlueprint.isFleet : false;

  // Auto-set service mode to 'new' for instance blueprints
  useEffect(() => {
    if (isInstance) {
      setServiceMode('new');
    }
  }, [isInstance]);

  // Reset new service deploying state when switching modes
  useEffect(() => {
    if (serviceMode !== 'new') {
      setNewServiceDeploying(false);
    }
  }, [serviceMode]);

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
      blueprintType: selectedBlueprint?.id,
      txHash,
      serviceId: serviceInfo ? Number(serviceId) : undefined,
      jobIndex: 0,
      phase: 'pending_confirmation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chainId: targetChain.id,
    });
  }, [txHash]); // eslint-disable-line react-hooks/exhaustive-deps


  // Wait for new service TX receipt
  useEffect(() => {
    if (!newServiceTxHash || !newServiceDeploying) return;
    publicClient
      .waitForTransactionReceipt({ hash: newServiceTxHash })
      .then((receipt: { status: string }) => {
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

  // Auto-provision instance bot via operator API after service activation
  const autoProvisionInstance = useCallback(async (activatedServiceId: string) => {
    setInstanceProvisioning(true);
    setInstanceProvisionError(null);

    // Retry with backoff — operator binary may not be ready yet
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        let authToken = operatorAuth.token;
        if (!authToken) {
          authToken = await operatorAuth.authenticate();
          if (!authToken) throw new Error('Wallet authentication failed');
        }

        // Resolve validator service IDs
        const resolvedValidatorIds: number[] = validatorMode === 'custom' && customValidatorIds.trim()
          ? customValidatorIds.split(',').flatMap(s => {
              const n = parseInt(s.trim(), 10);
              return !isNaN(n) && n > 0 ? [n] : [];
            })
          : (() => {
              const defaultId = import.meta.env.VITE_VALIDATOR_SERVICE_ID ?? '0';
              const n = parseInt(defaultId, 10);
              return !isNaN(n) && n > 0 ? [n] : [];
            })();

        const provisionBody = {
          name: name || `Instance Bot (service ${activatedServiceId})`,
          strategy_type: strategyType,
          strategy_config_json: JSON.stringify(
            (() => {
              const cfg: Record<string, unknown> = {};
              if (customExpertKnowledge) cfg.expert_knowledge_override = customExpertKnowledge;
              if (customInstructions) cfg.custom_instructions = customInstructions;
              return cfg;
            })(),
          ),
          trading_loop_cron: effectiveCron,
          validator_service_ids: resolvedValidatorIds,
        };

        const res = await fetch(`${OPERATOR_API_URL}/api/bot/provision`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(provisionBody),
        });

        // Auth retry
        if (res.status === 401) {
          operatorAuth.clearCachedToken();
          const fresh = await operatorAuth.authenticate();
          if (!fresh) throw new Error('Re-authentication failed');
          const retry = await fetch(`${OPERATOR_API_URL}/api/bot/provision`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${fresh}`,
            },
            body: JSON.stringify(provisionBody),
          });
          if (!retry.ok) throw new Error(await retry.text());
          const result = await retry.json();
          handleInstanceProvisionSuccess(activatedServiceId, result);
          return;
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText || `HTTP ${res.status}`);
        }

        const result = await res.json();
        handleInstanceProvisionSuccess(activatedServiceId, result);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (attempt < maxRetries - 1) {
          // Backoff: 2s, 4s, 8s, 16s
          await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
          continue;
        }
        setInstanceProvisionError(msg);
        toast.error(`Instance provision failed: ${msg.slice(0, 150)}`);
      }
    }
    setInstanceProvisioning(false);
  }, [name, strategyType, effectiveCron, validatorMode, customValidatorIds, customExpertKnowledge, customInstructions, operatorAuth]);

  const handleInstanceProvisionSuccess = useCallback((activatedServiceId: string, result: { bot_id: string; sandbox_id: string }) => {
    setInstanceProvisioning(false);
    setServiceId(activatedServiceId);

    // Create a tracked provision entry so the secrets step can find it
    addProvision({
      id: `instance-${activatedServiceId}`,
      owner: userAddress!,
      name: name || 'Instance Agent',
      strategyType,
      operators: [],
      blueprintId,
      blueprintType: selectedBlueprint?.id,
      serviceId: Number(activatedServiceId),
      jobIndex: 0,
      phase: 'awaiting_secrets',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chainId: targetChain.id,
      sandboxId: result.sandbox_id,
      callId: 0,
    });

    // Point txHash-like reference at the instance provision entry
    // so latestDeployment resolves to it
    resetTx();

    toast.success(`Instance provisioned! Configure API keys to start trading.`);
    setStep('secrets');
  }, [userAddress, name, strategyType, blueprintId, selectedBlueprint, targetChain.id, resetTx]);

  // Watch for ServiceActivated when deploying new service
  useEffect(() => {
    if (!newServiceDeploying) return;
    const unwatch = publicClient.watchContractEvent({
      address: addresses.tangle,
      abi: tangleServicesAbi,
      eventName: 'ServiceActivated',
      onLogs(logs: Array<{ args: { blueprintId?: bigint; serviceId?: bigint } }>) {
        for (const log of logs) {
          const bid = log.args.blueprintId;
          const sid = log.args.serviceId;
          if (bid == null || sid == null) continue;
          if (Number(bid) === Number(blueprintId)) {
            const activatedId = Number(sid).toString();
            setNewServiceDeploying(false);
            setShowInfra(false);

            if (isInstance) {
              // Instance blueprint: auto-provision via operator API
              toast.success(`Service #${activatedId} active! Provisioning instance bot...`);
              autoProvisionInstance(activatedId);
            } else {
              // Fleet blueprint: switch to existing service mode
              setServiceId(activatedId);
              setServiceMode('existing');
              toast.success(`Service #${activatedId} is live! Ready to provision agents.`);
              discoverServices();
            }
          }
        }
      },
    });
    return unwatch;
  }, [newServiceDeploying, blueprintId, isInstance, autoProvisionInstance]);

  // ── Service validation ─────────────────────────────────────────────────

  // Use ref for blueprintId to avoid cycle: validateService → setBlueprintId → validateService
  const blueprintIdRef = useRef(blueprintId);
  blueprintIdRef.current = blueprintId;

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

      const currentBid = blueprintIdRef.current;
      const blueprintMismatch = Number(svc.blueprintId) !== Number(currentBid);

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
        blueprintMismatch,
      });
    } catch (err) {
      setServiceError(
        err instanceof Error ? err.message.slice(0, 120) : 'Failed to fetch service',
      );
    } finally {
      setServiceLoading(false);
    }
  }, [serviceId, userAddress]);

  // Auto-validate service on mount and when service ID changes
  useEffect(() => {
    if (serviceMode === 'existing') {
      validateService();
    }
  }, [serviceId, serviceMode, validateService]);

  // Update mismatch flag when blueprint changes (without re-fetching service)
  useEffect(() => {
    if (serviceInfo) {
      const mismatch = serviceInfo.blueprintId !== Number(blueprintId);
      if (serviceInfo.blueprintMismatch !== mismatch) {
        setServiceInfo((prev) => prev ? { ...prev, blueprintMismatch: mismatch } : prev);
      }
    }
  }, [blueprintId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Service discovery — find services the user can deploy to ───────────

  const discoverServices = useCallback(async () => {
    if (!userAddress) return;
    setDiscoveryLoading(true);
    try {
      // Scan ServiceActivated events for this blueprint (bounded range for performance)
      let fromBlock = 0n;
      try {
        const latestBlock = await publicClient.getBlockNumber();
        // ~30 days of 12s blocks = 216_000 blocks; use a generous window
        const lookback = 250_000n;
        fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
      } catch {
        // Fall back to scanning from genesis if getBlockNumber fails
      }
      const logs = await publicClient.getLogs({
        address: addresses.tangle,
        event: {
          type: 'event',
          name: 'ServiceActivated',
          inputs: [
            { name: 'serviceId', type: 'uint64', indexed: true },
            { name: 'requestId', type: 'uint64', indexed: true },
            { name: 'blueprintId', type: 'uint64', indexed: true },
          ],
        },
        args: { blueprintId: BigInt(blueprintId) },
        fromBlock,
      });

      if (logs.length === 0) {
        setDiscoveredServices([]);
        setDiscoveryLoading(false);
        return;
      }

      // Check each service for active + permitted + owner
      type SvcLog = { args: { serviceId?: bigint } };
      const serviceIds: number[] = logs.map((log: SvcLog) => Number(log.args.serviceId!));
      const unique: number[] = [...new Set(serviceIds)];

      const results = await Promise.all(
        unique.map(async (sid) => {
          try {
            const sidBig = BigInt(sid);
            const [isActive, service, isPermitted] = await Promise.all([
              publicClient.readContract({
                address: addresses.tangle,
                abi: tangleServicesAbi,
                functionName: 'isServiceActive',
                args: [sidBig],
              }),
              publicClient.readContract({
                address: addresses.tangle,
                abi: tangleServicesAbi,
                functionName: 'getService',
                args: [sidBig],
              }),
              publicClient.readContract({
                address: addresses.tangle,
                abi: tangleServicesAbi,
                functionName: 'isPermittedCaller',
                args: [sidBig, userAddress],
              }),
            ]);

            const svc = service as { owner: Address; operatorCount: number };
            const isOwner = svc.owner.toLowerCase() === userAddress.toLowerCase();

            return {
              serviceId: sid,
              isActive,
              isPermitted: isPermitted || isOwner, // owners can always call
              isOwner,
              owner: svc.owner,
              operatorCount: svc.operatorCount,
            } satisfies DiscoveredService;
          } catch {
            return null;
          }
        }),
      );

      const valid = results.filter((r): r is DiscoveredService => r !== null);
      // Sort: active+permitted first, then active, then rest
      valid.sort((a, b) => {
        const scoreA = (a.isActive && a.isPermitted ? 4 : 0) + (a.isActive ? 2 : 0) + (a.isOwner ? 1 : 0);
        const scoreB = (b.isActive && b.isPermitted ? 4 : 0) + (b.isActive ? 2 : 0) + (b.isOwner ? 1 : 0);
        return scoreB - scoreA;
      });
      setDiscoveredServices(valid);

      // Auto-select the first active + permitted service
      const best = valid.find((s) => s.isActive && s.isPermitted);
      if (best) {
        setServiceId(best.serviceId.toString());
      }
    } catch {
      // Discovery is best-effort — don't block the user
    } finally {
      setDiscoveryLoading(false);
    }
  }, [blueprintId, userAddress]);

  // Run discovery on mount + auto-refresh every 60s
  useEffect(() => {
    if (!isConnected || !userAddress || serviceMode !== 'existing') return;
    discoverServices();
    const interval = setInterval(discoverServices, 60_000);
    return () => clearInterval(interval);
  }, [isConnected, userAddress, blueprintId, serviceMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Submit job ─────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!(await ensureCorrectChain()) || !userAddress) return;
    if (!name.trim()) {
      toast.error('Enter agent name');
      return;
    }
    if (!serviceInfo?.isActive) {
      toast.error('Service is not active — select an active service in Infrastructure Settings');
      return;
    }
    if (!serviceInfo?.isPermitted) {
      toast.error('Your wallet is not a permitted caller on this service');
      return;
    }

    const strategyConfig: Record<string, unknown> = {};
    if (customExpertKnowledge) strategyConfig.expert_knowledge_override = customExpertKnowledge;
    if (customInstructions) strategyConfig.custom_instructions = customInstructions;

    // Use the selected blueprint's encoder (or fall back to cloud defaults)
    const bp = selectedBlueprint ?? TRADING_BLUEPRINTS[0];

    // Resolve validator service IDs
    const resolvedValidatorIds: bigint[] = validatorMode === 'custom' && customValidatorIds.trim()
      ? customValidatorIds.split(',').flatMap(s => {
          const trimmed = s.trim();
          if (!trimmed || !/^\d+$/.test(trimmed)) return [];
          const n = BigInt(trimmed);
          return n > 0n ? [n] : [];
        })
      : (() => {
          const defaultId = import.meta.env.VITE_VALIDATOR_SERVICE_ID ?? '0';
          const n = BigInt(defaultId);
          return n > 0n ? [n] : [];
        })();

    // Resolve validator operators from on-chain to use as vault signers.
    // These are the addresses that will produce EIP-712 trade approval signatures.
    let vaultSigners: Address[] = [];
    if (resolvedValidatorIds.length > 0) {
      try {
        const operatorResults = await Promise.all(
          resolvedValidatorIds.map(vid =>
            publicClient.readContract({
              address: addresses.tangle,
              abi: tangleServicesAbi,
              functionName: 'getServiceOperators',
              args: [vid],
            }),
          ),
        );
        // Flatten and deduplicate operator addresses across all validator services
        const seen = new Set<string>();
        for (const ops of operatorResults) {
          for (const op of ops as Address[]) {
            const lower = op.toLowerCase();
            if (!seen.has(lower)) {
              seen.add(lower);
              vaultSigners.push(op);
            }
          }
        }
        if (vaultSigners.length === 0) {
          toast.error('Selected validator services have no operators — cannot create vault signers');
          return;
        }
      } catch (err) {
        console.error('[provision] Failed to resolve validator operators:', err);
        toast.error('Failed to query validator service operators from chain');
        return;
      }
    }

    const inputs = bp.encodeProvision({
      name,
      strategyType,
      strategyConfig,
      riskParams: '{}',
      vaultAddress: zeroAddress,
      assetAddress: (import.meta.env.VITE_USDC_ADDRESS ??
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') as Address,
      // Vault signers: validator operators (if validators selected), otherwise empty
      // (empty = BSM defaults to trading service operators)
      depositors: vaultSigners.length > 0 ? vaultSigners : [],
      chainId: BigInt(targetChain.id),
      rpcUrl: '',
      cron: effectiveCron,
      cpuCores: bp.defaults.cpuCores,
      memoryMb: bp.defaults.memoryMb,
      maxLifetimeDays: bp.defaults.maxLifetimeDays,
      validatorServiceIds: resolvedValidatorIds,
    });

    writeContract(
      {
        address: addresses.tangle,
        abi: tangleJobsAbi,
        functionName: 'submitJob',
        args: [BigInt(serviceId), 0, inputs],
      },
      {
        onError(err) {
          // Extract meaningful error from wagmi/viem error chain
          const msg = err.message || '';
          const shortName = (err as any).shortMessage || '';
          // Check for known revert reasons
          if (msg.includes('NotPermittedCaller') || msg.includes('d5dd5b44')) {
            toast.error('Not permitted — your wallet is not a permitted caller for this service');
          } else if (shortName) {
            toast.error(`Transaction failed: ${shortName.slice(0, 150)}`);
          } else {
            toast.error(`Transaction failed: ${msg.slice(0, 150)}`);
          }
          console.error('[provision] submitJob error:', err);
        },
      },
    );
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

    // Resolve validator service IDs for instance mode (needed for vault signers)
    let instanceValidatorIds: bigint[] = [];
    let instanceVaultSigners: Address[] = [];
    if (isInstance) {
      instanceValidatorIds = validatorMode === 'custom' && customValidatorIds.trim()
        ? customValidatorIds.split(',').flatMap(s => {
            const n = BigInt(s.trim() || '0');
            return n > 0n ? [n] : [];
          })
        : (() => {
            const defaultId = import.meta.env.VITE_VALIDATOR_SERVICE_ID ?? '0';
            const n = BigInt(defaultId);
            return n > 0n ? [n] : [];
          })();

      // Resolve validator operators as vault signers
      if (instanceValidatorIds.length > 0) {
        try {
          const opResults = await Promise.all(
            instanceValidatorIds.map(vid =>
              publicClient.readContract({
                address: addresses.tangle,
                abi: tangleServicesAbi,
                functionName: 'getServiceOperators',
                args: [vid],
              }),
            ),
          );
          const seen = new Set<string>();
          for (const ops of opResults) {
            for (const op of ops as Address[]) {
              const lower = op.toLowerCase();
              if (!seen.has(lower)) {
                seen.add(lower);
                instanceVaultSigners.push(op);
              }
            }
          }
        } catch (err) {
          console.warn('[provision] Failed to resolve validator operators for instance vault:', err);
        }
      }
    }

    // Encode config for the service (tuple-wrapped for alloy compat)
    // Instance mode fills bot fields so onServiceInitialized can create the vault.
    const bp = selectedBlueprint ?? TRADING_BLUEPRINTS[0];
    const config = encodeAbiParameters(
      parseAbiParameters(
        '(string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[])',
      ),
      [
        [
          isInstance ? (name || 'Instance Bot') : '',
          isInstance ? strategyType : '',
          isInstance ? JSON.stringify({
            ...(customExpertKnowledge ? { expert_knowledge_override: customExpertKnowledge } : {}),
            ...(customInstructions ? { custom_instructions: customInstructions } : {}),
          }) : '{}',
          '{}',                          // risk_params
          zeroAddress,                   // factory_address
          (import.meta.env.VITE_USDC_ADDRESS ??
            '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') as Address,
          isInstance ? instanceVaultSigners : [],   // signers for vault
          isInstance && instanceVaultSigners.length > 0 ? 1n : 0n,  // requiredSigs
          BigInt(targetChain.id),
          '',                            // rpc_url
          isInstance ? effectiveCron : '',
          bp.defaults.cpuCores,
          bp.defaults.memoryMb,
          bp.defaults.maxLifetimeDays,
          isInstance ? instanceValidatorIds : [],
        ],
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

    writeNewService(
      {
        address: addresses.tangle,
        abi: tangleServicesAbi,
        functionName: 'createServiceFromQuotes',
        args: [BigInt(blueprintId), quoteTuples, config, [userAddress], ttlBlocks],
        value: totalCost,
      },
      {
        onSuccess(hash) {
          setNewServiceTxHash(hash);
          setNewServiceDeploying(true);
        },
        onError(err) {
          toast.error(`New service failed: ${err.message.slice(0, 120)}`);
          setNewServiceDeploying(false);
        },
      },
    );
  };

  // ── Step navigation ────────────────────────────────────────────────────

  const stepIndex = STEP_ORDER.indexOf(step);

  const canNext = (() => {
    switch (step) {
      case 'blueprint':
        return !!selectedBlueprint;
      case 'configure':
        return !!name.trim();
      case 'deploy':
        return false;
    }
  })();

  const goNext = () => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) {
      // When moving from blueprint → configure, sync the blueprint ID
      if (step === 'blueprint' && selectedBlueprint) {
        setBlueprintId(selectedBlueprint.blueprintId);
      }
      setStep(STEP_ORDER[idx + 1]);
    }
  };

  const goBack = () => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx > 0) setStep(STEP_ORDER[idx - 1]);
  };

  // For fleet blueprints, match by txHash. For instance blueprints, also check instance provision entries.
  const latestDeployment = myProvisions.find((p) =>
    p.txHash === txHash ||
    (isInstance && p.id.startsWith('instance-') && p.phase !== 'failed'),
  );

  // Auto-advance to secrets step when provisioning completes with awaiting_secrets
  useEffect(() => {
    if (latestDeployment?.phase === 'awaiting_secrets' && step === 'deploy') {
      setStep('secrets');
    }
  }, [latestDeployment?.phase, step]);

  /** Resolve operator bot ID using multi-strategy lookup. */
  const resolveBotId = useCallback(async (opts: {
    sandboxId?: string;
    callId?: number;
    serviceId?: number;
  }): Promise<string | null> => {
    const result = await resolveBot(OPERATOR_API_URL, opts);
    if ('botId' in result) {
      setSecretsLookupError(null);
      return result.botId;
    }
    setSecretsLookupError(result.error);
    return null;
  }, []);

  const [useOperatorKey, setUseOperatorKey] = useState(false);

  const handleSubmitSecrets = async () => {
    if (!latestDeployment) return;
    if (!latestDeployment.sandboxId && !latestDeployment.callId) return;
    if (!useOperatorKey && !apiKey.trim()) return;

    setIsSubmittingSecrets(true);
    setActivationPhase(null);
    setSecretsLookupError(null);

    const botId = await resolveBotId({
      sandboxId: latestDeployment.sandboxId,
      callId: latestDeployment.callId,
      serviceId: latestDeployment.serviceId,
    });
    if (!botId) {
      setIsSubmittingSecrets(false);
      return;
    }

    // Poll activation progress with failure limit
    let pollFailures = 0;
    const pollInterval = setInterval(async () => {
      try {
        const progressUrl = isInstance
          ? `${OPERATOR_API_URL}/api/bot/activation-progress`
          : `${OPERATOR_API_URL}/api/bots/${botId}/activation-progress`;
        const res = await fetch(progressUrl);
        if (res.ok) {
          const data = await res.json();
          setActivationPhase(data.phase ?? null);
          pollFailures = 0;
        } else {
          pollFailures++;
        }
      } catch {
        pollFailures++;
      }
      if (pollFailures >= 10) {
        clearInterval(pollInterval);
      }
    }, 1000);

    try {
      const envJson: Record<string, string> = useOperatorKey
        ? {} // Empty — tells the operator to use its own pre-configured keys
        : buildEnvForProvider(aiProvider, apiKey.trim());
      if (!useOperatorKey) {
        for (const e of extraEnvs) {
          if (e.key.trim() && e.value.trim()) {
            envJson[e.key.trim()] = e.value.trim();
          }
        }
      }

      let authToken = operatorAuth.token;
      if (!authToken) {
        authToken = await operatorAuth.authenticate();
        if (!authToken) throw new Error('Wallet authentication failed');
      }

      // Instance blueprints use singleton /api/bot/secrets, fleet uses /api/bots/:botId/secrets
      const secretsUrl = isInstance
        ? `${OPERATOR_API_URL}/api/bot/secrets`
        : `${OPERATOR_API_URL}/api/bots/${botId}/secrets`;

      const postSecrets = async (tok: string) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000); // 60s timeout
        try {
          return await fetch(secretsUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${tok}`,
            },
            body: JSON.stringify({ env_json: envJson }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      };

      let res = await postSecrets(authToken);

      // If auth failed (stale token from previous operator session), re-authenticate and retry once
      if (res.status === 401 || (!res.ok && (await res.clone().text()).includes('PASETO'))) {
        operatorAuth.clearCachedToken();
        const freshToken = await operatorAuth.authenticate();
        if (!freshToken) throw new Error('Wallet re-authentication failed');
        authToken = freshToken;
        res = await postSecrets(freshToken);
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const result = await res.json();

      updateProvision(latestDeployment.id, {
        phase: 'active',
        workflowId: result.workflow_id,
        sandboxId: result.sandbox_id ?? latestDeployment.sandboxId,
      });

      toast.success('API keys configured — agent is now active!');
      setApiKey('');
      setExtraEnvs([]);
    } catch (err) {
      toast.error(
        `Configuration failed: ${err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'}`,
      );
    } finally {
      clearInterval(pollInterval);
      setIsSubmittingSecrets(false);
      setActivationPhase(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-arena-elements-textTertiary hover:text-violet-700 dark:hover:text-violet-400 mb-6 font-display font-medium transition-colors"
      >
        <span>&larr;</span> Leaderboard
      </Link>

      <h1 className="font-display font-bold text-3xl tracking-tight mb-1.5">
        Provision Trading Agent
      </h1>
      <p className="text-base text-arena-elements-textSecondary mb-6">
        {step === 'blueprint' && 'Choose a blueprint type for your trading agent.'}
        {step === 'configure' && `Configure your ${selectedBlueprint?.name ?? 'trading'} agent, then provision it on-chain.`}
        {step === 'deploy' && 'Your agent is being provisioned on the network.'}
        {step === 'secrets' && 'Provide your API keys to activate the trading agent.'}
      </p>

      {/* Step indicator */}
      <div className="flex items-center mb-8">
        {STEP_ORDER.map((s, i) => {
          const isCurrent = s === step;
          const isDone = i < stepIndex;
          return (
            <Fragment key={s}>
              <button
                type="button"
                onClick={() => {
                  if (!isDone) return;
                  // Don't allow navigating backwards past deploy once TX is in flight
                  if (txHash && STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf('deploy')) return;
                  setStep(s);
                }}
                disabled={!isDone && !isCurrent}
                className={`flex items-center gap-2.5 text-sm font-display font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isCurrent
                    ? 'text-violet-700 dark:text-violet-400'
                    : isDone
                      ? 'text-arena-elements-textSecondary hover:text-violet-600 dark:hover:text-violet-400 cursor-pointer'
                      : 'text-arena-elements-textTertiary cursor-default'
                }`}
              >
                <span
                  className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-data font-bold shrink-0 transition-all duration-300 ${
                    isCurrent
                      ? 'bg-violet-500 text-white shadow-[0_0_10px_rgba(139,92,246,0.3)]'
                      : isDone
                        ? 'bg-emerald-400 text-white shadow-[0_0_8px_rgba(0,255,136,0.2)]'
                        : 'bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 text-arena-elements-textTertiary border border-arena-elements-borderColor'
                  }`}
                >
                  {isDone ? '\u2713' : i + 1}
                </span>
                {STEP_LABELS[s]}
              </button>
              {i < STEP_ORDER.length - 1 && (
                <div
                  className={`flex-1 h-px mx-3 transition-colors duration-300 ${i < stepIndex ? 'bg-emerald-400/50' : 'bg-arena-elements-borderColor'}`}
                />
              )}
            </Fragment>
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

        {/* ── Step 0: Blueprint Selection ────────────────────────────── */}
        {step === 'blueprint' && (
          <div className="space-y-6">
            <BlueprintSelector
              blueprints={TRADING_BLUEPRINTS}
              selected={selectedBlueprint?.id ?? null}
              onSelect={(id) => {
                const bp = getBlueprint(id);
                if (bp) {
                  setSelectedBlueprint(bp);
                  setBlueprintId(bp.blueprintId);
                }
              }}
            />

            <div className="flex justify-end">
              <Button
                disabled={!selectedBlueprint}
                onClick={goNext}
                className="bg-violet-600 hover:bg-violet-700 text-white"
              >
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 1: Configure ─────────────────────────────────────── */}
        {step === 'configure' && (
          <>
            {/* Compact infrastructure bar at top */}
            <button
              type="button"
              onClick={() => setShowInfra(true)}
              className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg border border-arena-elements-borderColor/60 hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 transition-colors group"
            >
              <div className="flex items-center gap-3">
                {isInstance ? (
                  <>
                    <span className="w-2 h-2 rounded-full shrink-0 bg-violet-400" />
                    <span className="text-xs font-data text-arena-elements-textSecondary">
                      {selectedBlueprint?.name ?? 'Instance'} — New service will be created
                      {selectedOperators.size > 0 && ` (${selectedOperators.size} operators)`}
                    </span>
                  </>
                ) : (
                  <>
                    {serviceInfo && (
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${serviceInfo.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
                      />
                    )}
                    {serviceLoading && (
                      <span className="w-2 h-2 rounded-full shrink-0 bg-amber-400 animate-pulse" />
                    )}
                    <span className="text-xs font-data text-arena-elements-textSecondary">
                      Service {serviceId}
                      {serviceInfo && serviceInfo.isActive && ` (Active, ${serviceInfo.operators.length} operators)`}
                      {serviceInfo && !serviceInfo.isActive && ' (Inactive)'}
                      {serviceError && ' (Error)'}
                      {serviceLoading && ' (Checking...)'}
                      {discoveryLoading && ' (Discovering...)'}
                    </span>
                    {serviceInfo && !serviceInfo.isPermitted && userAddress && (
                      <span className="text-[11px] text-amber-600 dark:text-amber-400">Not permitted</span>
                    )}
                    {serviceInfo?.blueprintMismatch && (
                      <span className="text-[11px] text-crimson-600 dark:text-crimson-400">
                        Wrong blueprint (service uses #{serviceInfo.blueprintId})
                      </span>
                    )}
                  </>
                )}
              </div>
              <span className="text-xs font-data text-arena-elements-textTertiary group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
                {isInstance ? 'Configure' : 'Change'}
              </span>
            </button>

            <Card>
              <CardContent className="pt-5 pb-4">
                <label htmlFor="agent-name" className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Agent Name
                </label>
                <Input
                  id="agent-name"
                  placeholder="e.g. Alpha DEX Bot"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5 pb-5 space-y-4">
                <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                  Strategy Profile
                </span>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-2">
                    {strategyPacks.filter((p) => !p.id.startsWith('prediction')).map((p) => {
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
                  <div>
                    <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary block mb-1.5">
                      Prediction Markets
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                      {strategyPacks.filter((p) => p.id.startsWith('prediction')).map((p) => {
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
                  </div>
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

            <div className="flex justify-end">
              <Button onClick={goNext} disabled={!canNext} size="lg">
                Next: Provision Agent
              </Button>
            </div>
          </>
        )}

        {/* ── Step 4: Provision Agent ──────────────────────────────── */}
        {step === 'deploy' && (
          <>
            {/* Instance blueprint: create service → auto-provision */}
            {isInstance && !latestDeployment && (
              <Card>
                <CardContent className="pt-5 pb-5 space-y-4">
                  <div>
                    <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                      Create Instance Service
                    </span>
                    <p className="text-xs text-arena-elements-textTertiary mt-1">
                      This creates a dedicated service for your trading bot. The vault is created on-chain
                      and the sidecar is provisioned automatically.
                    </p>
                  </div>
                  <div className="p-3.5 rounded-lg bg-arena-elements-item-backgroundHover/30 border border-arena-elements-borderColor/40">
                    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm font-data">
                      <span className="text-arena-elements-textTertiary">Blueprint</span>
                      <span className="text-arena-elements-textPrimary">{selectedBlueprint?.name ?? 'Instance'}</span>
                      <span className="text-arena-elements-textTertiary">Agent</span>
                      <span className="text-arena-elements-textPrimary">{name}</span>
                      <span className="text-arena-elements-textTertiary">Strategy</span>
                      <span className="text-arena-elements-textPrimary">{selectedPack.name}</span>
                      <span className="text-arena-elements-textTertiary">Frequency</span>
                      <span className="text-arena-elements-textPrimary">
                        Every {cronToHuman(effectiveCron)}
                      </span>
                      <span className="text-arena-elements-textTertiary">Operators</span>
                      <span className="text-arena-elements-textPrimary">
                        {selectedOperators.size > 0 ? `${selectedOperators.size} selected` : 'None — select in Infrastructure Settings'}
                      </span>
                    </div>
                  </div>

                  {selectedOperators.size === 0 && (
                    <Button
                      variant="outline"
                      onClick={() => setShowInfra(true)}
                      className="w-full"
                    >
                      Select Operators
                    </Button>
                  )}

                  {selectedOperators.size > 0 && quotes.length === 0 && !isQuoting && (
                    <Button
                      variant="outline"
                      onClick={() => { setShowInfra(true); refetchQuotes(); }}
                      className="w-full"
                    >
                      Get Operator Quotes
                    </Button>
                  )}

                  {isQuoting && (
                    <div className="text-center text-sm text-arena-elements-textTertiary animate-pulse py-2">
                      Fetching operator quotes...
                    </div>
                  )}

                  {quotes.length > 0 && (
                    <Button
                      onClick={handleDeployNewService}
                      className="w-full"
                      size="lg"
                      disabled={!isConnected || isNewServicePending || newServiceDeploying || instanceProvisioning}
                    >
                      {!isConnected
                        ? 'Connect Wallet'
                        : isNewServicePending
                          ? 'Confirm in Wallet...'
                          : newServiceDeploying
                            ? 'Waiting for Service Activation...'
                            : instanceProvisioning
                              ? 'Provisioning Instance Bot...'
                              : `Create Instance Service (${formatCost(totalCost)})`}
                    </Button>
                  )}

                  {instanceProvisionError && (
                    <div className="text-sm text-crimson-400 p-3 rounded-lg bg-crimson-500/5 border border-crimson-500/20">
                      {instanceProvisionError}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Fleet blueprint: standard submitJob flow */}
            {!isInstance && !txHash && (
              <Card>
                <CardContent className="pt-5 pb-5 space-y-4">
                  <div>
                    <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                      Provision Agent
                    </span>
                    <p className="text-xs text-arena-elements-textTertiary mt-1">
                      This submits a job to Service {serviceId}. The operator will spin up a sidecar container
                      running your trading agent with the configuration below.
                    </p>
                  </div>
                  <div className="p-3.5 rounded-lg bg-arena-elements-item-backgroundHover/30 border border-arena-elements-borderColor/40">
                    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm font-data">
                      <span className="text-arena-elements-textTertiary">Service</span>
                      <span className="text-arena-elements-textPrimary">#{serviceId}</span>
                      <span className="text-arena-elements-textTertiary">Agent</span>
                      <span className="text-arena-elements-textPrimary">{name}</span>
                      <span className="text-arena-elements-textTertiary">Strategy</span>
                      <span className="text-arena-elements-textPrimary">{selectedPack.name}</span>
                      <span className="text-arena-elements-textTertiary">Frequency</span>
                      <span className="text-arena-elements-textPrimary">
                        Every {cronToHuman(effectiveCron)}
                      </span>
                      <span className="text-arena-elements-textTertiary">On-chain call</span>
                      <span className="text-arena-elements-textPrimary font-data text-xs">
                        submitJob(serviceId={serviceId}, jobIndex=0, ...)
                      </span>
                    </div>
                  </div>
                  <Button
                    onClick={handleSubmit}
                    className="w-full"
                    size="lg"
                    disabled={!isConnected || isPending || !serviceInfo?.isActive || !serviceInfo?.isPermitted || serviceInfo?.blueprintMismatch}
                  >
                    {!isConnected
                      ? 'Connect Wallet'
                      : serviceInfo?.blueprintMismatch
                        ? `Wrong Blueprint (service uses #${serviceInfo.blueprintId})`
                        : !serviceInfo?.isActive
                          ? 'Service Not Active'
                          : !serviceInfo?.isPermitted
                            ? 'Not Permitted on Service'
                            : isPending
                              ? 'Confirm in Wallet...'
                              : 'Provision Agent'}
                  </Button>
                </CardContent>
              </Card>
            )}

            {txHash && (
              <Card className="border-arena-elements-borderColor/60 overflow-hidden">
                <CardContent className="pt-5 pb-5 space-y-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      {latestDeployment && !['active', 'awaiting_secrets', 'failed'].includes(latestDeployment.phase) && (
                        <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      )}
                      {latestDeployment?.phase === 'awaiting_secrets' && (
                        <div className="w-2 h-2 rounded-full bg-emerald-400" />
                      )}
                      {latestDeployment?.phase === 'active' && (
                        <div className="w-2 h-2 rounded-full bg-emerald-400" />
                      )}
                      {latestDeployment?.phase === 'failed' && (
                        <div className="w-2 h-2 rounded-full bg-crimson-400" />
                      )}
                      <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                        Agent Provisioning
                      </span>
                    </div>
                    {latestDeployment && !['active', 'awaiting_secrets', 'failed'].includes(latestDeployment.phase) && (
                      <ElapsedTime since={latestDeployment.createdAt} />
                    )}
                  </div>

                  {/* Vertical timeline */}
                  <div className="relative pl-7">
                    {/* Connecting line */}
                    <div className="absolute left-[8px] top-[8px] bottom-[8px] w-px bg-arena-elements-borderColor/60 overflow-hidden">
                      {latestDeployment && ['pending_confirmation', 'job_submitted', 'job_processing'].includes(latestDeployment.phase) && (
                        <div className="absolute inset-0 w-full animate-shimmer bg-gradient-to-b from-transparent via-amber-400/50 to-transparent" style={{ backgroundSize: '100% 200%' }} />
                      )}
                      {latestDeployment && ['awaiting_secrets', 'active'].includes(latestDeployment.phase) && (
                        <div className="absolute inset-0 w-full bg-gradient-to-b from-emerald-400/40 to-emerald-400/10" />
                      )}
                    </div>

                    <TimelineStage
                      label="Transaction Sent"
                      description="Waiting for your submitJob transaction to be confirmed on-chain"
                      status={
                        latestDeployment?.phase === 'pending_confirmation'
                          ? 'active'
                          : latestDeployment?.phase === 'job_submitted' ||
                              latestDeployment?.phase === 'job_processing' ||
                              latestDeployment?.phase === 'awaiting_secrets' ||
                              latestDeployment?.phase === 'active'
                            ? 'done'
                            : latestDeployment?.phase === 'failed'
                              ? 'error'
                              : 'active'
                      }
                      isFirst
                    />
                    <TimelineStage
                      label="Operator Processing"
                      description={
                        latestDeployment?.phase === 'job_submitted' || latestDeployment?.phase === 'job_processing'
                          ? (PROVISION_PROGRESS_LABELS[latestDeployment?.progressPhase ?? ''] ?? 'Waiting for an operator to pick up your job...')
                          : latestDeployment?.phase === 'awaiting_secrets' || latestDeployment?.phase === 'active'
                            ? 'Infrastructure provisioned successfully'
                            : 'An operator will detect your job and provision a sidecar container'
                      }
                      status={
                        latestDeployment?.phase === 'job_submitted' ||
                        latestDeployment?.phase === 'job_processing'
                          ? 'active'
                          : latestDeployment?.phase === 'awaiting_secrets' ||
                              latestDeployment?.phase === 'active'
                            ? 'done'
                            : latestDeployment?.phase === 'failed'
                              ? 'error'
                              : 'pending'
                      }
                    />
                    <TimelineStage
                      label="Configure API Keys"
                      description="Infrastructure deployed. Provide your API keys on the dashboard to activate the agent."
                      status={
                        latestDeployment?.phase === 'awaiting_secrets'
                          ? 'active'
                          : latestDeployment?.phase === 'active'
                            ? 'done'
                            : latestDeployment?.phase === 'failed'
                              ? 'error'
                              : 'pending'
                      }
                    />
                    <TimelineStage
                      label="Agent Live"
                      description="Your trading agent is running inside its sidecar and the vault is deployed on-chain"
                      status={
                        latestDeployment?.phase === 'active'
                          ? 'done'
                          : latestDeployment?.phase === 'failed'
                            ? 'error'
                            : 'pending'
                      }
                      isLast
                    />
                  </div>

                  {latestDeployment?.phase === 'failed' && latestDeployment.errorMessage && (
                    <div className="text-sm text-crimson-400 p-3 rounded-lg bg-crimson-500/5 border border-crimson-500/20">
                      {latestDeployment.errorMessage}
                    </div>
                  )}

                  {latestDeployment?.phase === 'awaiting_secrets' && (
                    <div className="p-3.5 rounded-lg bg-emerald-500/5 border border-emerald-500/30 space-y-2">
                      <div className="text-sm font-display font-medium text-emerald-400">
                        Infrastructure Deployed — Ready for Activation
                      </div>
                      <p className="text-sm text-arena-elements-textSecondary">
                        Your sidecar and vault are ready. Provide your API keys to start trading.
                      </p>
                      <Button
                        size="sm"
                        onClick={() => setStep('secrets')}
                        className="mt-1"
                      >
                        Next: Activate Agent &rarr;
                      </Button>
                    </div>
                  )}

                  {latestDeployment?.phase === 'active' && (
                    <div className="p-3.5 rounded-lg bg-emerald-700/5 border border-emerald-700/30 dark:bg-emerald-500/5 dark:border-emerald-500/30 space-y-2">
                      <div className="text-sm font-display font-medium text-arena-elements-icon-success">
                        Agent Provisioned Successfully
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
                      {(latestDeployment.vaultAddress && latestDeployment.vaultAddress !== zeroAddress) ? (
                        <Link
                          to={`/arena/bot/${latestDeployment.vaultAddress.toLowerCase()}`}
                          className="inline-flex items-center gap-1.5 text-sm font-display font-medium text-violet-700 dark:text-violet-400 hover:underline mt-1"
                        >
                          View Bot &rarr;
                        </Link>
                      ) : latestDeployment.sandboxId ? (
                        <Link
                          to={`/arena/bot/${encodeURIComponent(latestDeployment.sandboxId)}`}
                          className="inline-flex items-center gap-1.5 text-sm font-display font-medium text-violet-700 dark:text-violet-400 hover:underline mt-1"
                        >
                          View Bot &rarr;
                        </Link>
                      ) : null}
                    </div>
                  )}

                  <div className="text-xs font-data text-arena-elements-textTertiary truncate">
                    TX: {txHash}
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={goBack} disabled={!!txHash}>
                Back
              </Button>
              {txHash && !latestDeployment?.phase?.match(/active|awaiting_secrets|failed/) && (
                <span className="text-sm text-arena-elements-textTertiary animate-pulse self-center">
                  Waiting for operator...
                </span>
              )}
              {latestDeployment?.phase === 'awaiting_secrets' && (
                <Button
                  onClick={() => setStep('secrets')}
                >
                  Next: Activate &rarr;
                </Button>
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
                  Provision Another Agent
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

        {/* ── Step 3: Activate (Set Secrets) ────────────────────────── */}
        {step === 'secrets' && latestDeployment && (
          <>
            {/* Deployment success summary */}
            <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                <span className="text-sm font-display font-semibold text-emerald-400">
                  Infrastructure Deployed
                </span>
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm font-data">
                {latestDeployment.sandboxId && (
                  <>
                    <span className="text-arena-elements-textTertiary">Sandbox</span>
                    <span className="text-arena-elements-textPrimary truncate">{latestDeployment.sandboxId}</span>
                  </>
                )}
                {latestDeployment.vaultAddress && latestDeployment.vaultAddress !== zeroAddress && (
                  <>
                    <span className="text-arena-elements-textTertiary">Vault</span>
                    <span className="text-arena-elements-textPrimary truncate">{latestDeployment.vaultAddress}</span>
                  </>
                )}
                {latestDeployment.callId != null && (
                  <>
                    <span className="text-arena-elements-textTertiary">Call ID</span>
                    <span className="text-arena-elements-textPrimary">{latestDeployment.callId}</span>
                  </>
                )}
              </div>
            </div>

            {/* Secrets form */}
            <Card>
              <CardContent className="pt-5 pb-5 space-y-4">
                <div>
                  <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                    Configure API Keys
                  </span>
                  <p className="text-xs text-arena-elements-textTertiary mt-1">
                    Your agent needs an AI provider key to operate. Keys are sent directly to the operator over HTTPS — never stored on-chain.
                  </p>
                </div>

                {secretsLookupError && (
                  <div className="text-sm text-amber-500 p-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                    {secretsLookupError}
                  </div>
                )}

                {/* Use operator key toggle */}
                <button
                  type="button"
                  onClick={() => setUseOperatorKey(!useOperatorKey)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                    useOperatorKey
                      ? 'border-violet-500/50 bg-violet-500/10 ring-1 ring-violet-500/20'
                      : 'border-arena-elements-borderColor bg-arena-elements-background-depth-3 hover:border-arena-elements-borderColorActive'
                  }`}
                >
                  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    useOperatorKey ? 'border-violet-500 bg-violet-500' : 'border-arena-elements-textTertiary'
                  }`}>
                    {useOperatorKey && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <span className="text-sm font-display font-medium text-arena-elements-textPrimary">
                      Use operator-provided key
                    </span>
                    <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                      Skip API key entry — the operator has pre-configured keys for this agent.
                    </p>
                  </div>
                </button>

                {/* Provider selector */}
                {!useOperatorKey && <>
                <div role="group" aria-label="AI Provider">
                  <span className="text-sm font-display font-medium text-arena-elements-textPrimary block mb-1.5">
                    AI Provider
                  </span>
                  <div className="flex gap-2">
                    {AI_PROVIDERS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setAiProvider(p.id);
                          if (p.id === defaultProvider && DEFAULT_AI_API_KEY) {
                            setApiKey(DEFAULT_AI_API_KEY);
                          } else {
                            setApiKey('');
                          }
                        }}
                        className={`flex-1 px-3 py-2.5 rounded-lg text-sm font-data border transition-all ${
                          aiProvider === p.id
                            ? 'border-violet-500/50 bg-violet-500/10 text-arena-elements-textPrimary ring-1 ring-violet-500/20'
                            : 'border-arena-elements-borderColor bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 text-arena-elements-textSecondary hover:border-arena-elements-borderColorActive'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-arena-elements-textTertiary mt-1">
                    Model: {(AI_PROVIDERS.find((p) => p.id === aiProvider) ?? AI_PROVIDERS[0]).modelName}
                  </p>
                </div>

                {/* API Key input */}
                <div>
                  <label htmlFor="secrets-api-key" className="text-sm font-display font-medium text-arena-elements-textPrimary block mb-1.5">
                    API Key <span className="text-crimson-400">*</span>
                  </label>
                  <Input
                    id="secrets-api-key"
                    type="password"
                    placeholder={(AI_PROVIDERS.find((p) => p.id === aiProvider) ?? AI_PROVIDERS[0]).placeholder}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  {apiKey && DEFAULT_AI_API_KEY && apiKey === DEFAULT_AI_API_KEY && (
                    <p className="text-xs text-emerald-500 mt-1">Pre-filled from local config</p>
                  )}
                </div>

                {/* Extra env vars */}
                {extraEnvs.map((env, i) => (
                  <div key={env.id} className="flex gap-2">
                    <Input
                      placeholder="KEY"
                      value={env.key}
                      onChange={(e) => {
                        const updated = [...extraEnvs];
                        updated[i] = { ...env, key: e.target.value };
                        setExtraEnvs(updated);
                      }}
                      className="flex-1"
                    />
                    <Input
                      type="password"
                      placeholder="value"
                      value={env.value}
                      onChange={(e) => {
                        const updated = [...extraEnvs];
                        updated[i] = { ...env, value: e.target.value };
                        setExtraEnvs(updated);
                      }}
                      className="flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setExtraEnvs(extraEnvs.filter((_, j) => j !== i))}
                      className="text-arena-elements-textTertiary hover:text-crimson-400 transition-colors px-1"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => {
                    envIdRef.current += 1;
                    setExtraEnvs([...extraEnvs, { id: envIdRef.current, key: '', value: '' }]);
                  }}
                  className="text-xs font-data text-violet-700 dark:text-violet-400 hover:underline"
                >
                  + Add environment variable
                </button>
                </>}

                {/* Activation progress */}
                {isSubmittingSecrets && activationPhase && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
                    <div className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin shrink-0" />
                    <span className="text-sm font-data text-amber-400">
                      {ACTIVATION_LABELS[activationPhase] ?? activationPhase}
                    </span>
                  </div>
                )}

                <Button
                  onClick={handleSubmitSecrets}
                  className="w-full"
                  size="lg"
                  disabled={(!useOperatorKey && !apiKey.trim()) || isSubmittingSecrets}
                >
                  {isSubmittingSecrets ? 'Signing & Configuring...' : useOperatorKey ? 'Sign & Activate (Operator Key)' : 'Sign & Activate Agent'}
                </Button>
              </CardContent>
            </Card>

            {latestDeployment.phase === 'active' && (
              <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 space-y-3">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm font-display font-semibold text-emerald-400">
                    Agent Activated Successfully
                  </span>
                </div>
                {(latestDeployment.vaultAddress && latestDeployment.vaultAddress !== zeroAddress) ? (
                  <Link
                    to={`/arena/bot/${latestDeployment.vaultAddress.toLowerCase()}`}
                    className="inline-flex items-center gap-1.5 text-sm font-display font-medium text-violet-700 dark:text-violet-400 hover:underline"
                  >
                    View Bot &rarr;
                  </Link>
                ) : latestDeployment.sandboxId ? (
                  <Link
                    to={`/arena/bot/${encodeURIComponent(latestDeployment.sandboxId)}`}
                    className="inline-flex items-center gap-1.5 text-sm font-display font-medium text-violet-700 dark:text-violet-400 hover:underline"
                  >
                    View Bot &rarr;
                  </Link>
                ) : null}
              </div>
            )}

            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setStep('deploy')}
                disabled={isSubmittingSecrets}
              >
                Back
              </Button>
              {latestDeployment.phase === 'active' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    resetTx();
                    setName('');
                    setApiKey(DEFAULT_AI_API_KEY);
                    setExtraEnvs([]);
                    setStep('configure');
                  }}
                >
                  Provision Another Agent
                </Button>
              )}
            </div>
          </>
        )}

      </div>

      {/* ── Infrastructure Settings Dialog ────────────────────────────── */}
      <Dialog open={showInfra} onOpenChange={setShowInfra}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display text-lg">
              Infrastructure Settings
            </DialogTitle>
            <DialogDescription className="text-sm">
              Configure which service your agent will be provisioned on.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Service mode toggle — instance blueprints always create new */}
            <div className="space-y-2">
              <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                Service
              </span>
              {isInstance && (
                <div className="p-3 rounded-lg bg-violet-500/5 border border-violet-500/30 text-sm text-arena-elements-textSecondary">
                  Instance blueprints create a dedicated service per bot. Each service runs exactly one trading agent.
                </div>
              )}
              {!isInstance && (
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
                    <div className={`text-sm font-display font-semibold ${serviceMode === 'existing' ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}>
                      Use Existing
                    </div>
                    <div className="text-xs text-arena-elements-textTertiary mt-0.5">
                      Join a running service
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
                    <div className={`text-sm font-display font-semibold ${serviceMode === 'new' ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}>
                      Create New
                    </div>
                    <div className="text-xs text-arena-elements-textTertiary mt-0.5">
                      Deploy new infrastructure
                    </div>
                  </button>
                </div>
              )}
            </div>

            {/* Existing service config */}
            {serviceMode === 'existing' && (
              <ServiceDropdown
                discoveredServices={discoveredServices}
                discoveryLoading={discoveryLoading}
                serviceId={serviceId}
                serviceInfo={serviceInfo}
                serviceLoading={serviceLoading}
                serviceError={serviceError}
                userAddress={userAddress}
                onSelect={(id) => setServiceId(id)}
              />
            )}

            {/* New service config */}
            {serviceMode === 'new' && (
              <div className="space-y-3">
                <div>
                  <span className="text-sm font-data text-arena-elements-textSecondary block mb-2">
                    Select Operators ({operatorCount.toString()} available)
                  </span>
                  {discoveredOperators.length > 0 ? (
                    <div className="grid gap-1.5">
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
                            <Identicon address={op.address} size={22} />
                            <span className="font-data text-sm truncate flex-1">{op.address}</span>
                            {sel && <Badge variant="success" className="text-xs">Selected</Badge>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-arena-elements-textTertiary py-2">
                      No operators found for blueprint {blueprintId}.
                    </div>
                  )}
                  <div className="flex gap-2 mt-2">
                    <Input
                      placeholder="0x... (manual address)"
                      value={manualOperator}
                      onChange={(e) => setManualOperator(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addManualOperator()}
                      className="text-xs h-8"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addManualOperator} className="text-xs h-8">
                      Add
                    </Button>
                  </div>
                </div>

                {/* Quotes */}
                {selectedOperators.size > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-data text-arena-elements-textSecondary">Operator Quotes</span>
                      <Button type="button" variant="outline" size="sm" onClick={refetchQuotes} disabled={isQuoting} className="text-[10px] h-6 px-2">
                        {isQuoting ? 'Fetching...' : 'Refresh'}
                      </Button>
                    </div>
                    {isQuoting && quotes.length === 0 && (
                      <div className="text-xs text-arena-elements-textTertiary py-2 text-center animate-pulse">
                        Solving PoW challenge...
                      </div>
                    )}
                    {quotes.length > 0 && (
                      <div className="space-y-1.5">
                        {quotes.map((q) => (
                          <div key={q.operator} className="flex items-center gap-2 p-2 rounded border border-emerald-700/30 bg-emerald-700/5 dark:border-emerald-500/30 dark:bg-emerald-500/5">
                            <Identicon address={q.operator} size={18} />
                            <span className="font-data text-xs truncate flex-1">{q.operator}</span>
                            <span className="font-data text-xs text-arena-elements-icon-success shrink-0">{formatCost(q.totalCost)}</span>
                          </div>
                        ))}
                        <div className="flex items-center justify-between px-1">
                          <span className="text-[11px] font-data text-arena-elements-textSecondary">Total</span>
                          <span className="font-data text-xs font-semibold">{formatCost(totalCost)}</span>
                        </div>
                      </div>
                    )}
                    {quoteErrors.size > 0 && (
                      <div className="space-y-1">
                        {Array.from(quoteErrors.entries()).map(([addr, msg]) => (
                          <div key={addr} className="text-[11px] text-crimson-400 truncate">
                            {addr.slice(0, 10)}...{addr.slice(-4)}: {msg}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Deploy new service button */}
                {quotes.length > 0 && (
                  <div>
                    <Button
                      onClick={handleDeployNewService}
                      className="w-full"
                      size="sm"
                      disabled={!isConnected || isNewServicePending || newServiceDeploying || isQuoting}
                    >
                      {!isConnected
                        ? 'Connect Wallet'
                        : isNewServicePending
                          ? 'Confirm in Wallet...'
                          : newServiceDeploying
                            ? 'Waiting for Activation...'
                            : `Create Service (${formatCost(totalCost)})`}
                    </Button>
                    {newServiceDeploying && (
                      <div className="text-center mt-2 space-y-1">
                        <p className="text-[11px] text-arena-elements-textTertiary animate-pulse">
                          Waiting for operators to activate...
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => { setNewServiceDeploying(false); setNewServiceTxHash(undefined); }}
                          className="text-[11px] h-6"
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-arena-elements-dividerColor">
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              size="sm"
              onClick={() => setShowInfra(false)}
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
                  <label htmlFor="cron-schedule" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Cron Schedule
                  </label>
                  <Input
                    id="cron-schedule"
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
                  <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Max Turns
                  </span>
                  <span className="text-sm font-data text-arena-elements-textPrimary">
                    {selectedPack.maxTurns} per iteration
                  </span>
                </div>
                <div>
                  <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Timeout
                  </span>
                  <span className="text-sm font-data text-arena-elements-textPrimary">
                    {selectedPack.timeoutMs / 1000}s per iteration
                  </span>
                </div>
                <div>
                  <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Providers
                  </span>
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
                {/* Validator Configuration */}
                <div className="pt-4 border-t border-arena-elements-dividerColor">
                  <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-3 block">
                    Validator Configuration
                  </span>
                  <div className="space-y-2">
                    <label className="flex items-start gap-3 cursor-pointer rounded-lg p-2.5 hover:bg-arena-elements-background-depth-2 transition-colors">
                      <input
                        type="radio"
                        name="validator-mode"
                        checked={validatorMode === 'default'}
                        onChange={() => setValidatorMode('default')}
                        className="mt-0.5 accent-violet-600"
                      />
                      <div>
                        <span className="text-sm font-medium text-arena-elements-textPrimary">
                          Default validators
                        </span>
                        <span className="ml-1.5 text-xs text-arena-elements-textTertiary">(recommended)</span>
                        <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                          {(import.meta.env.VITE_VALIDATOR_SERVICE_ID ?? '0') !== '0'
                            ? `Uses validator service ${import.meta.env.VITE_VALIDATOR_SERVICE_ID} for AI trade scoring`
                            : 'Paper-trade mode (no validator configured)'}
                        </p>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 cursor-pointer rounded-lg p-2.5 hover:bg-arena-elements-background-depth-2 transition-colors">
                      <input
                        type="radio"
                        name="validator-mode"
                        checked={validatorMode === 'custom'}
                        onChange={() => setValidatorMode('custom')}
                        className="mt-0.5 accent-violet-600"
                      />
                      <div className="flex-1">
                        <span className="text-sm font-medium text-arena-elements-textPrimary">
                          Specific validator service IDs
                        </span>
                        <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                          Choose which on-chain validator services score your trades
                        </p>
                        {validatorMode === 'custom' && (
                          <Input
                            value={customValidatorIds}
                            onChange={(e) => setCustomValidatorIds(e.target.value)}
                            placeholder="e.g. 1, 3, 7"
                            className="mt-2 font-data text-sm"
                          />
                        )}
                      </div>
                    </label>
                  </div>
                </div>

                {(customCron || validatorMode === 'custom') && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => { setCustomCron(''); setValidatorMode('default'); setCustomValidatorIds(''); }}
                    className="text-xs"
                  >
                    Reset to Defaults
                  </Button>
                )}
              </div>
            </TabsContent>
          </Tabs>

          <div className="pt-3 border-t border-arena-elements-dividerColor">
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              size="sm"
              onClick={() => setShowAdvanced(false)}
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Timeline Stage Component ─────────────────────────────────────────────

function TimelineStage({
  label,
  description,
  status,
  isFirst,
  isLast,
}: {
  label: string;
  description: string;
  status: 'pending' | 'active' | 'done' | 'error';
  isFirst?: boolean;
  isLast?: boolean;
}) {
  return (
    <div className={`relative flex gap-3 ${isFirst ? '' : 'mt-5'} ${isLast ? '' : 'pb-0'}`}>
      {/* Node dot — positioned over the connecting line */}
      <div
        className={`absolute -left-6 top-[2px] z-10 flex items-center justify-center w-[17px] h-[17px] rounded-full border-2 transition-all duration-500 ${
          status === 'done'
            ? 'bg-emerald-400 border-emerald-400 shadow-[0_0_12px_rgba(0,255,136,0.3)]'
            : status === 'active'
              ? 'bg-amber-400 border-amber-400 shadow-[0_0_12px_rgba(255,184,0,0.4),0_0_24px_rgba(255,184,0,0.15)]'
              : status === 'error'
                ? 'bg-crimson-400 border-crimson-400 shadow-[0_0_10px_rgba(255,59,92,0.3)]'
                : 'bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 border-arena-elements-borderColor'
        }`}
      >
        {status === 'done' && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
        {status === 'active' && (
          <>
            <div className="w-1.5 h-1.5 rounded-full bg-white" />
            {/* Pulsing ring */}
            <div className="absolute inset-0 rounded-full border-2 border-amber-400/50 animate-ping" />
          </>
        )}
        {status === 'error' && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm font-display font-semibold transition-colors duration-300 ${
            status === 'done'
              ? 'text-emerald-400'
              : status === 'active'
                ? 'text-amber-400'
                : status === 'error'
                  ? 'text-crimson-400'
                  : 'text-arena-elements-textTertiary'
          }`}
        >
          {label}
        </div>
        <div
          className={`text-xs font-data leading-relaxed mt-0.5 transition-all duration-300 ${
            status === 'active'
              ? 'text-arena-elements-textSecondary opacity-100'
              : status === 'done'
                ? 'text-arena-elements-textTertiary opacity-70'
                : 'text-arena-elements-textTertiary opacity-50'
          }`}
        >
          {description}
        </div>
      </div>
    </div>
  );
}

// ── Elapsed Time Counter ─────────────────────────────────────────────────

// ── Service Dropdown ──────────────────────────────────────────────────────

function ServiceDropdown({
  discoveredServices,
  discoveryLoading,
  serviceId,
  serviceInfo,
  serviceLoading,
  serviceError,
  userAddress,
  onSelect,
}: {
  discoveredServices: DiscoveredService[];
  discoveryLoading: boolean;
  serviceId: string;
  serviceInfo: ServiceInfo | null;
  serviceLoading: boolean;
  serviceError: string | null;
  userAddress: Address | undefined;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = discoveredServices.find((ds) => ds.serviceId.toString() === serviceId);

  return (
    <div className="space-y-3">
      {discoveryLoading && discoveredServices.length === 0 && (
        <div className="text-sm text-arena-elements-textTertiary py-3 text-center animate-pulse">
          Scanning for available services...
        </div>
      )}

      {!discoveryLoading && discoveredServices.length === 0 && userAddress && (
        <div className="text-sm text-arena-elements-textTertiary py-3 text-center">
          No services found. Try creating a new service instead.
        </div>
      )}

      {discoveredServices.length > 0 && (
        <div className="relative">
          <span className="text-sm font-data text-arena-elements-textSecondary block mb-2">
            Select Service
          </span>

          {/* Selected service trigger */}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 transition-colors text-left"
          >
            {selected ? (
              <>
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${selected.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
                />
                <span className="font-data text-sm text-arena-elements-textPrimary flex-1">
                  Service #{selected.serviceId}
                </span>
                <span className="text-xs font-data text-arena-elements-textTertiary">
                  {selected.operatorCount} operator{selected.operatorCount !== 1 ? 's' : ''}
                </span>
                {selected.isOwner && (
                  <Badge variant="outline" className="text-xs">Owner</Badge>
                )}
                {selected.isPermitted && !selected.isOwner && (
                  <Badge variant="outline" className="text-xs">Permitted</Badge>
                )}
              </>
            ) : (
              <>
                {serviceLoading ? (
                  <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-amber-400 animate-pulse" />
                ) : null}
                <span className="font-data text-sm text-arena-elements-textTertiary flex-1">
                  Service #{serviceId}
                </span>
              </>
            )}
            <svg
              className={`w-4 h-4 text-arena-elements-textTertiary transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* Dropdown options */}
          {open && (
            <div className="mt-1.5 rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-2 shadow-lg overflow-hidden">
              {discoveredServices.map((ds) => {
                const isSelected = serviceId === ds.serviceId.toString();
                return (
                  <button
                    key={ds.serviceId}
                    type="button"
                    onClick={() => {
                      onSelect(ds.serviceId.toString());
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      isSelected
                        ? 'bg-violet-500/10'
                        : ds.isActive && ds.isPermitted
                          ? 'hover:bg-arena-elements-item-backgroundHover'
                          : 'opacity-50'
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${ds.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
                    />
                    <span className="font-data text-sm text-arena-elements-textPrimary flex-1">
                      Service #{ds.serviceId}
                    </span>
                    <span className="text-xs font-data text-arena-elements-textTertiary">
                      {ds.operatorCount} op{ds.operatorCount !== 1 ? 's' : ''}
                    </span>
                    {ds.isOwner && (
                      <Badge variant="outline" className="text-[11px]">Owner</Badge>
                    )}
                    {ds.isPermitted && !ds.isOwner && (
                      <Badge variant="outline" className="text-[11px]">Permitted</Badge>
                    )}
                    {!ds.isPermitted && (
                      <Badge variant="destructive" className="text-[11px]">No Access</Badge>
                    )}
                    {isSelected && (
                      <svg className="w-4 h-4 text-violet-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {serviceError && (
        <div className="text-sm text-crimson-400 p-3 rounded-lg bg-crimson-500/5 border border-crimson-500/20">
          {serviceError}
        </div>
      )}

      {/* Service details (shown below dropdown for the selected service) */}
      {serviceInfo && (
        <div className="p-3.5 rounded-lg bg-arena-elements-item-backgroundHover/30 border border-arena-elements-borderColor/40 space-y-2">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${serviceInfo.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
            />
            <span className="text-sm font-display font-medium text-arena-elements-textPrimary">
              Service {serviceId} — {serviceInfo.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-y-1.5 text-sm font-data">
            <span className="text-arena-elements-textTertiary">Owner</span>
            <span className="text-arena-elements-textPrimary truncate">{serviceInfo.owner}</span>
            <span className="text-arena-elements-textTertiary">Operators</span>
            <span className="text-arena-elements-textPrimary">{serviceInfo.operators.length}</span>
            <span className="text-arena-elements-textTertiary">TTL</span>
            <span className="text-arena-elements-textPrimary">
              {serviceInfo.ttl > 0 ? `${Math.floor(serviceInfo.ttl / 86400)}d` : 'Unlimited'}
            </span>
          </div>
          {serviceInfo.operators.length > 0 && (
            <div className="pt-1 space-y-1">
              {serviceInfo.operators.map((addr) => (
                <div key={addr} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1">
                  <Identicon address={addr} size={18} />
                  <span className="font-data text-xs text-arena-elements-textSecondary truncate">{addr}</span>
                </div>
              ))}
            </div>
          )}
          {!serviceInfo.isPermitted && userAddress && (
            <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 pt-1">
              <span>Your address is not a permitted caller. The transaction may revert.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ElapsedTime({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - since) / 1000)));
  useEffect(() => {
    setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    const interval = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000))), 1000);
    return () => clearInterval(interval);
  }, [since]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return (
    <span className="text-xs font-data text-arena-elements-textTertiary tabular-nums">
      {mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`}
    </span>
  );
}
