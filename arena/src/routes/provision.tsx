import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  Fragment,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useAccount, useWriteContract, useSwitchChain } from 'wagmi';
import { useStore } from '@nanostores/react';
import {
  decodeEventLog,
  encodeAbiParameters,
  parseAbiParameters,
  parseGwei,
  zeroAddress,
} from 'viem';
import type { Address } from 'viem';
import { Button } from '@tangle-network/blueprint-ui/components';
import { toast } from 'sonner';
import {
  tangleJobsAbi,
  tangleServicesAbi,
  tradingBlueprintAbi,
} from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { networks } from '~/lib/contracts/chains';
import {
  publicClient,
  selectedChainIdStore,
  useOperators,
} from '@tangle-network/blueprint-ui';
import { useQuotes } from '~/lib/hooks/useQuotes';
import { PricingModelHint } from '~/lib/gen/pricing_pb';
import { addTx } from '@tangle-network/blueprint-ui';
import {
  provisionsForOwner,
  addProvision,
  upsertInstanceProvision,
  removeProvision,
  removeMatchingInstanceProvision,
  updateProvision,
  type TrackedProvision,
  type InstanceProvisionIdentity,
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
} from '~/lib/blueprints';
import { BlueprintSelector } from '~/components/provision/BlueprintSelector';
import { ConfigureStep } from '~/components/provision/ConfigureStep';
import { DeployStep } from '~/components/provision/DeployStep';
import { SecretsStep } from '~/components/provision/SecretsStep';
import { InfrastructureDialog } from '~/components/provision/InfrastructureDialog';
import { AdvancedSettingsDialog } from '~/components/provision/AdvancedSettingsDialog';
import { resolveBotId as resolveBot } from '~/lib/utils/resolveBotId';
import {
  buildBotScopedPath,
  getExpectedDeploymentKindForBlueprint,
  getOperatorApiUrlForBlueprint,
  useOperatorMeta,
} from '~/lib/operator/meta';
import { useRouteOperatorAutoAuth } from '~/lib/hooks/useRouteOperatorAutoAuth';
import { dispatchBotsRefresh } from '~/lib/events/bots';
import {
  isStaleStateError,
  readOperatorError,
  type OperatorErrorBody,
} from '~/lib/operator/errors';
import { normalizeWorkflowId } from '~/lib/utils/workflowId';
import {
  type WizardStep,
  STEP_ORDER,
  STEP_LABELS,
  type ServiceInfo,
  type DiscoveredService,
} from './provision/types';
import type { BotLifecycleStatus, ValidationTrust } from '~/lib/types/bot';

export const FIRECRACKER_RUNTIME_SUPPORTED = false;

export type RuntimeBackend = 'docker' | 'firecracker' | 'tee';

interface StrategyConfigOptions {
  runtimeBackend: RuntimeBackend;
  isTeeBlueprint: boolean;
  customExpertKnowledge?: string;
  customInstructions?: string;
  firecrackerRuntimeSupported?: boolean;
  paperTrade?: boolean;
  protocolChainId?: number;
  availableProtocols?: string[];
  conversationCron?: string;
  researchCron?: string;
  conversationEnabled?: boolean;
  researchEnabled?: boolean;
}

interface ProvisionStrategyConfigOptions extends StrategyConfigOptions {
  strategyType: string;
  selectedExecutionTarget?: DexExecutionTargetOption;
  includeExecutionTarget: boolean;
  executionConfig?: ExecutionTargetProvisionConfig | null;
}

interface OperatorProvisionBodyOptions extends ProvisionStrategyConfigOptions {
  name: string;
  fallbackName: string;
  effectiveCron: string;
  validatorServiceIds: bigint[];
  vaultAddress?: Address;
  validationTrust?: ValidationTrust;
}

interface InstanceServiceConfigOptions extends StrategyConfigOptions {
  isInstance: boolean;
  name: string;
  strategyType: string;
  effectiveCron: string;
  validatorServiceIds: bigint[];
  vaultSigners: Address[];
  collateralBps: bigint;
  targetChainId: number;
  assetAddress: Address;
  blueprintDefaults: {
    cpuCores: bigint;
    memoryMb: bigint;
    maxLifetimeDays: bigint;
  };
  validationTrust?: ValidationTrust;
}

type ParsedServiceIds =
  | { ok: true; ids: bigint[] }
  | { ok: false; message: string };

type DexExecutionTargetId =
  | 'ethereum'
  | 'ethereum-mainnet'
  | 'base'
  | 'base-mainnet'
  | 'arbitrum-fork'
  | 'arbitrum'
  | 'arbitrum-one'
  | 'polygon'
  | 'optimism';

interface DexExecutionTargetOption {
  id: DexExecutionTargetId;
  label: string;
  description: string;
  modeLabel?: string;
  enabled: boolean;
  chainId?: number;
  rpcUrl?: string;
  vaultFactoryAddress?: string;
  vaultAddress?: string;
  assetToken?: string;
  paperTrade?: boolean;
  protocolChainId?: number;
}

type VaultBinding = 'factory' | 'direct';

interface ExecutionTargetProvisionConfig {
  chainId: bigint;
  rpcUrl: string;
  vaultBinding: VaultBinding;
  provisionVaultAddress: Address;
  vaultFactoryAddress: Address | undefined;
  vaultAddress: Address;
  assetAddress: Address;
  paperTrade: boolean;
  protocolChainId: number | undefined;
}

interface SubmitSnapshot {
  name: string;
  selectedPackName: string;
  targetChainId: number;
  owner?: Address;
  strategyType: string;
  operators: Address[];
  blueprintId: string;
  blueprintType?: string;
  serviceId?: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BASE_SEPOLIA_USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ETHEREUM_USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const POLYGON_USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const OPTIMISM_USDC_ADDRESS = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const ARBITRUM_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  137: 'Polygon',
  8453: 'Base',
  84532: 'Base Sepolia',
  31339: 'Ethereum Fork',
  31340: 'Arbitrum Fork',
  42161: 'Arbitrum One',
  421614: 'Arbitrum Sepolia',
};

function resolveEnvBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveEnvPositiveNumber(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_BASE_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'base',
  label: 'Base Sepolia (Cloud)',
  description: 'Uses Base Sepolia for cloud paper-trading execution.',
  modeLabel: 'Cloud execution',
  enabled: resolveEnvBoolean(import.meta.env.VITE_DEX_BASE_ENABLED, true),
  chainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_BASE_CHAIN_ID,
    84532,
  ),
  rpcUrl: import.meta.env.VITE_DEX_BASE_RPC_URL ?? 'https://sepolia.base.org',
  vaultFactoryAddress: import.meta.env.VITE_DEX_BASE_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_DEX_BASE_VAULT_ADDRESS,
  assetToken:
    import.meta.env.VITE_DEX_BASE_ASSET_TOKEN ?? BASE_SEPOLIA_USDC_ADDRESS,
  paperTrade: resolveEnvBoolean(
    import.meta.env.VITE_DEX_BASE_PAPER_TRADE,
    true,
  ),
};

const DEFAULT_BASE_MAINNET_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'base-mainnet',
  label: 'Base',
  description: 'Uses Base mainnet for live EVM execution.',
  modeLabel: 'Live EVM execution',
  enabled: resolveEnvBoolean(
    import.meta.env.VITE_DEX_BASE_MAINNET_ENABLED,
    false,
  ),
  chainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_BASE_MAINNET_CHAIN_ID,
    8453,
  ),
  rpcUrl:
    import.meta.env.VITE_DEX_BASE_MAINNET_RPC_URL ?? 'https://mainnet.base.org',
  vaultFactoryAddress: import.meta.env
    .VITE_DEX_BASE_MAINNET_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_DEX_BASE_MAINNET_VAULT_ADDRESS,
  assetToken:
    import.meta.env.VITE_DEX_BASE_MAINNET_ASSET_TOKEN ?? BASE_USDC_ADDRESS,
  paperTrade: resolveEnvBoolean(
    import.meta.env.VITE_DEX_BASE_MAINNET_PAPER_TRADE,
    false,
  ),
};

const DEFAULT_ETHEREUM_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'ethereum',
  label: 'Ethereum Fork (Local Live)',
  description:
    'Uses the local Ethereum fork for live transaction execution. This is not Ethereum mainnet.',
  modeLabel: 'Local live fork',
  enabled: resolveEnvBoolean(import.meta.env.VITE_DEX_ETHEREUM_ENABLED, true),
  chainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_ETHEREUM_CHAIN_ID,
    31339,
  ),
  protocolChainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_ETHEREUM_PROTOCOL_CHAIN_ID,
    1,
  ),
  rpcUrl: import.meta.env.VITE_DEX_ETHEREUM_RPC_URL ?? 'http://127.0.0.1:42545',
  vaultFactoryAddress: import.meta.env.VITE_DEX_ETHEREUM_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_DEX_ETHEREUM_VAULT_ADDRESS,
  assetToken:
    import.meta.env.VITE_DEX_ETHEREUM_ASSET_TOKEN ??
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  paperTrade: resolveEnvBoolean(
    import.meta.env.VITE_DEX_ETHEREUM_PAPER_TRADE,
    false,
  ),
};

const DEFAULT_ETHEREUM_MAINNET_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'ethereum-mainnet',
  label: 'Ethereum',
  description: 'Uses Ethereum mainnet for live EVM execution.',
  modeLabel: 'Live EVM execution',
  enabled: resolveEnvBoolean(
    import.meta.env.VITE_DEX_ETHEREUM_MAINNET_ENABLED,
    false,
  ),
  chainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_ETHEREUM_MAINNET_CHAIN_ID,
    1,
  ),
  rpcUrl:
    import.meta.env.VITE_DEX_ETHEREUM_MAINNET_RPC_URL ??
    'https://ethereum-rpc.publicnode.com',
  vaultFactoryAddress: import.meta.env
    .VITE_DEX_ETHEREUM_MAINNET_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_DEX_ETHEREUM_MAINNET_VAULT_ADDRESS,
  assetToken:
    import.meta.env.VITE_DEX_ETHEREUM_MAINNET_ASSET_TOKEN ??
    ETHEREUM_USDC_ADDRESS,
  paperTrade: resolveEnvBoolean(
    import.meta.env.VITE_DEX_ETHEREUM_MAINNET_PAPER_TRADE,
    false,
  ),
};

const DEFAULT_ARBITRUM_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'arbitrum',
  label: 'Arbitrum Sepolia',
  description: 'Optional execution target for Arbitrum Sepolia.',
  modeLabel: 'Cloud execution',
  enabled: resolveEnvBoolean(import.meta.env.VITE_DEX_ARBITRUM_ENABLED, false),
  chainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_ARBITRUM_CHAIN_ID,
    421614,
  ),
  rpcUrl:
    import.meta.env.VITE_DEX_ARBITRUM_RPC_URL ??
    'https://sepolia-rollup.arbitrum.io/rpc',
  vaultFactoryAddress: import.meta.env.VITE_DEX_ARBITRUM_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_DEX_ARBITRUM_VAULT_ADDRESS,
  assetToken: import.meta.env.VITE_DEX_ARBITRUM_ASSET_TOKEN ?? ZERO_ADDRESS,
  paperTrade: resolveEnvBoolean(
    import.meta.env.VITE_DEX_ARBITRUM_PAPER_TRADE,
    true,
  ),
};

const DEFAULT_ARBITRUM_FORK_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'arbitrum-fork',
  label: 'Arbitrum Fork (Local Live)',
  description:
    'Uses a local Arbitrum One fork for GMX v2 and Vertex EVM perp execution.',
  modeLabel: 'Local Arbitrum fork',
  enabled: resolveEnvBoolean(
    import.meta.env.VITE_DEX_ARBITRUM_FORK_ENABLED,
    false,
  ),
  chainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_ARBITRUM_FORK_CHAIN_ID,
    31340,
  ),
  protocolChainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_ARBITRUM_FORK_PROTOCOL_CHAIN_ID,
    42161,
  ),
  rpcUrl:
    import.meta.env.VITE_DEX_ARBITRUM_FORK_RPC_URL ?? 'http://127.0.0.1:42546',
  vaultFactoryAddress: import.meta.env
    .VITE_DEX_ARBITRUM_FORK_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_DEX_ARBITRUM_FORK_VAULT_ADDRESS,
  assetToken:
    import.meta.env.VITE_DEX_ARBITRUM_FORK_ASSET_TOKEN ?? ARBITRUM_USDC_ADDRESS,
  paperTrade: resolveEnvBoolean(
    import.meta.env.VITE_DEX_ARBITRUM_FORK_PAPER_TRADE,
    false,
  ),
};

const DEFAULT_ARBITRUM_ONE_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'arbitrum-one',
  label: 'Arbitrum One',
  description:
    'Uses Arbitrum One for live GMX v2 and Vertex EVM perp execution.',
  modeLabel: 'Live EVM execution',
  enabled: resolveEnvBoolean(
    import.meta.env.VITE_DEX_ARBITRUM_ONE_ENABLED,
    false,
  ),
  chainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_ARBITRUM_ONE_CHAIN_ID,
    42161,
  ),
  rpcUrl:
    import.meta.env.VITE_DEX_ARBITRUM_ONE_RPC_URL ??
    'https://arb1.arbitrum.io/rpc',
  vaultFactoryAddress: import.meta.env
    .VITE_DEX_ARBITRUM_ONE_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_DEX_ARBITRUM_ONE_VAULT_ADDRESS,
  assetToken: import.meta.env.VITE_DEX_ARBITRUM_ONE_ASSET_TOKEN ?? ZERO_ADDRESS,
  paperTrade: resolveEnvBoolean(
    import.meta.env.VITE_DEX_ARBITRUM_ONE_PAPER_TRADE,
    false,
  ),
};

const DEFAULT_POLYGON_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'polygon',
  label: 'Polygon',
  description: 'Uses Polygon for Polymarket prediction market execution.',
  modeLabel: 'Prediction market execution',
  enabled: resolveEnvBoolean(import.meta.env.VITE_POLYGON_ENABLED, false),
  chainId: resolveEnvPositiveNumber(import.meta.env.VITE_POLYGON_CHAIN_ID, 137),
  rpcUrl: import.meta.env.VITE_POLYGON_RPC_URL ?? 'https://polygon-rpc.com',
  vaultFactoryAddress: import.meta.env.VITE_POLYGON_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_POLYGON_VAULT_ADDRESS,
  assetToken: import.meta.env.VITE_POLYGON_ASSET_TOKEN ?? POLYGON_USDC_ADDRESS,
  paperTrade: resolveEnvBoolean(import.meta.env.VITE_POLYGON_PAPER_TRADE, true),
};

const DEFAULT_OPTIMISM_EXECUTION_TARGET: DexExecutionTargetOption = {
  id: 'optimism',
  label: 'Optimism',
  description: 'Uses Optimism for live EVM execution.',
  modeLabel: 'Live EVM execution',
  enabled: resolveEnvBoolean(import.meta.env.VITE_DEX_OPTIMISM_ENABLED, false),
  chainId: resolveEnvPositiveNumber(
    import.meta.env.VITE_DEX_OPTIMISM_CHAIN_ID,
    10,
  ),
  rpcUrl:
    import.meta.env.VITE_DEX_OPTIMISM_RPC_URL ?? 'https://mainnet.optimism.io',
  vaultFactoryAddress: import.meta.env.VITE_DEX_OPTIMISM_VAULT_FACTORY_ADDRESS,
  vaultAddress: import.meta.env.VITE_DEX_OPTIMISM_VAULT_ADDRESS,
  assetToken:
    import.meta.env.VITE_DEX_OPTIMISM_ASSET_TOKEN ?? OPTIMISM_USDC_ADDRESS,
  paperTrade: resolveEnvBoolean(
    import.meta.env.VITE_DEX_OPTIMISM_PAPER_TRADE,
    false,
  ),
};

export function resolveSelectedProvisionNetwork(
  selectedChainId: number | undefined | null,
) {
  const configuredNetworks = Object.values(networks);
  return (
    (selectedChainId != null ? networks[selectedChainId] : undefined) ??
    configuredNetworks[0]
  );
}

export function resolveRuntimeBackendForProvision(
  runtimeBackend: RuntimeBackend,
  isTeeBlueprint: boolean,
  firecrackerRuntimeSupported = FIRECRACKER_RUNTIME_SUPPORTED,
): RuntimeBackend {
  if (isTeeBlueprint) return 'tee';
  if (runtimeBackend === 'tee') return 'docker';
  if (!firecrackerRuntimeSupported && runtimeBackend === 'firecracker')
    return 'docker';
  return runtimeBackend;
}

export function buildStrategyConfigForProvision({
  runtimeBackend,
  isTeeBlueprint,
  customExpertKnowledge,
  customInstructions,
  firecrackerRuntimeSupported,
  paperTrade,
  protocolChainId,
  availableProtocols,
  conversationCron,
  researchCron,
  conversationEnabled = true,
  researchEnabled = true,
}: StrategyConfigOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {
    runtime_backend: resolveRuntimeBackendForProvision(
      runtimeBackend,
      isTeeBlueprint,
      firecrackerRuntimeSupported,
    ),
  };
  if (paperTrade != null) config.paper_trade = paperTrade;
  if (
    protocolChainId != null &&
    Number.isFinite(protocolChainId) &&
    protocolChainId > 0
  ) {
    config.protocol_chain_id = protocolChainId;
  }
  if (availableProtocols?.length)
    config.available_protocols = availableProtocols;
  if (conversationCron || researchCron || !conversationEnabled || !researchEnabled) {
    config.workflow_schedules = {
      ...(conversationCron ? { conversation_cron: conversationCron } : {}),
      ...(researchCron ? { research_cron: researchCron } : {}),
      conversation_enabled: conversationEnabled,
      research_enabled: researchEnabled,
    };
  }
  if (customExpertKnowledge)
    config.expert_knowledge_override = customExpertKnowledge;
  if (customInstructions) config.custom_instructions = customInstructions;
  return config;
}

export function parsePositiveServiceIds(
  value: string | undefined,
  label = 'Service IDs',
): ParsedServiceIds {
  if (!value?.trim()) return { ok: true, ids: [] };

  const ids: bigint[] = [];
  for (const rawToken of value.split(',')) {
    const token = rawToken.trim();
    if (!token) continue;
    if (!/^\d+$/.test(token)) {
      return {
        ok: false,
        message: `${label} must be comma-separated positive whole numbers.`,
      };
    }
    const id = BigInt(token);
    if (id <= 0n) {
      return {
        ok: false,
        message: `${label} must be greater than zero.`,
      };
    }
    ids.push(id);
  }

  return { ok: true, ids };
}

export function resolveValidatorServiceIds({
  validatorMode,
  customValidatorIds,
  defaultValidatorServiceId,
}: {
  validatorMode: 'default' | 'custom';
  customValidatorIds: string;
  defaultValidatorServiceId?: string;
}): ParsedServiceIds {
  if (validatorMode === 'custom') {
    return parsePositiveServiceIds(customValidatorIds, 'Validator service IDs');
  }

  const parsed = parsePositiveServiceIds(
    defaultValidatorServiceId ?? '',
    'Default validator service ID',
  );
  return parsed.ok ? parsed : { ok: true, ids: [] };
}

export function buildProvisionStrategyConfig({
  strategyType,
  selectedExecutionTarget,
  includeExecutionTarget,
  executionConfig,
  ...strategyConfigOptions
}: ProvisionStrategyConfigOptions): Record<string, unknown> {
  const config = buildStrategyConfigForProvision({
    ...strategyConfigOptions,
    protocolChainId: includeExecutionTarget
      ? executionConfig?.protocolChainId
      : undefined,
    availableProtocols: includeExecutionTarget
      ? availableProtocolsForStrategyTarget(strategyType, selectedExecutionTarget)
      : undefined,
  });

  if (includeExecutionTarget && executionConfig) {
    config.vault_binding = executionConfig.vaultBinding;
    if (
      executionConfig.vaultBinding === 'direct' &&
      executionConfig.vaultAddress &&
      executionConfig.vaultAddress !== zeroAddress
    ) {
      config.direct_vault_address = executionConfig.vaultAddress;
    }
  }

  return config;
}

export function buildOperatorProvisionBody({
  name,
  fallbackName,
  strategyType,
  effectiveCron,
  validatorServiceIds,
  vaultAddress,
  selectedExecutionTarget,
  includeExecutionTarget,
  executionConfig,
  validationTrust,
  ...strategyConfigOptions
}: OperatorProvisionBodyOptions) {
  const strategyConfig = buildProvisionStrategyConfig({
    ...strategyConfigOptions,
    strategyType,
    selectedExecutionTarget,
    includeExecutionTarget,
    executionConfig,
  });

  return {
    name: name || fallbackName,
    strategy_type: strategyType,
    strategy_config_json: JSON.stringify(strategyConfig),
    risk_params_json:
      strategyType === 'yield'
        ? JSON.stringify({ min_aave_health_factor: 1.5 })
        : '{}',
    trading_loop_cron: effectiveCron,
    validator_service_ids: validatorServiceIds.map((id) => Number(id)),
    // Only include `validation_trust` when it diverges from the default
    // (`per_trade`). Older operator builds reject unknown fields, so
    // omitting the field preserves the old behavior unchanged.
    ...(validationTrust && validationTrust !== 'per_trade'
      ? { validation_trust: validationTrust }
      : {}),
    ...(includeExecutionTarget && executionConfig
      ? {
          chain_id: Number(executionConfig.chainId),
          rpc_url: executionConfig.rpcUrl,
          ...(vaultAddress ? { vault_address: vaultAddress } : {}),
          asset_token: executionConfig.assetAddress,
          paper_trade: executionConfig.paperTrade,
        }
      : {}),
  };
}

export function buildInstanceServiceConfig({
  isInstance,
  name,
  strategyType,
  effectiveCron,
  validatorServiceIds,
  vaultSigners,
  collateralBps,
  targetChainId,
  assetAddress,
  blueprintDefaults,
  validationTrust,
  ...strategyConfigOptions
}: InstanceServiceConfigOptions): `0x${string}` {
  return encodeAbiParameters(
    parseAbiParameters(
      '(string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[], uint256, uint8)',
    ),
    [
      [
        isInstance ? name || 'Instance Bot' : '',
        isInstance ? strategyType : '',
        isInstance
          ? JSON.stringify(buildStrategyConfigForProvision(strategyConfigOptions))
          : '{}',
        '{}',
        zeroAddress,
        assetAddress,
        isInstance ? vaultSigners : [],
        isInstance && vaultSigners.length > 0 ? 1n : 0n,
        BigInt(targetChainId),
        '',
        isInstance ? effectiveCron : '',
        blueprintDefaults.cpuCores,
        blueprintDefaults.memoryMb,
        blueprintDefaults.maxLifetimeDays,
        isInstance ? validatorServiceIds : [],
        collateralBps,
        validationTrustToDiscriminant(validationTrust),
      ],
    ],
  );
}

/** Map the UI's validationTrust string to the on-chain `uint8` discriminant.
 *  Must match the `validation_trust` field in `TradingProvisionRequest` (lib.rs). */
function validationTrustToDiscriminant(value: string | undefined): number {
  switch (value) {
    case 'envelope':
      return 1;
    case 'self_operated':
      return 2;
    default:
      return 0; // PerTrade (default)
  }
}

export function resolveExecutionTargetProvisionConfig(
  target: DexExecutionTargetOption | undefined,
): ExecutionTargetProvisionConfig | null {
  const configuredFactoryAddress = nonZeroAddress(target?.vaultFactoryAddress);
  const configuredVaultAddress = nonZeroAddress(target?.vaultAddress);
  const hasDistinctFactory =
    configuredFactoryAddress &&
    (!configuredVaultAddress ||
      !sameAddress(configuredFactoryAddress, configuredVaultAddress));
  const vaultBinding: VaultBinding =
    hasDistinctFactory || (!configuredVaultAddress && target?.paperTrade)
      ? 'factory'
      : 'direct';
  const provisionVaultAddress = hasDistinctFactory
    ? configuredFactoryAddress
    : (configuredVaultAddress ??
      (target?.paperTrade ? (ZERO_ADDRESS as Address) : undefined));
  if (!target?.enabled) return null;
  if (
    target.chainId == null ||
    !target.rpcUrl ||
    !provisionVaultAddress ||
    !target.assetToken
  ) {
    return null;
  }

  return {
    chainId: BigInt(target.chainId),
    rpcUrl: target.rpcUrl,
    vaultBinding,
    provisionVaultAddress,
    vaultFactoryAddress: configuredFactoryAddress,
    vaultAddress:
      configuredVaultAddress ??
      configuredFactoryAddress ??
      provisionVaultAddress,
    assetAddress: target.assetToken as Address,
    paperTrade: target.paperTrade ?? false,
    protocolChainId: target.protocolChainId,
  };
}

function nonZeroAddress(value: string | undefined | null): Address | undefined {
  if (typeof value !== 'string' || value.toLowerCase() === ZERO_ADDRESS)
    return undefined;
  return value as Address;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function instanceVaultEnvAddressForBlueprint(
  blueprint: TradingBlueprintDef | undefined,
): Address | undefined {
  if (!blueprint || blueprint.isFleet) return undefined;
  return nonZeroAddress(
    blueprint.isTee
      ? import.meta.env.VITE_TEE_VAULT_ADDRESS
      : import.meta.env.VITE_INSTANCE_VAULT_ADDRESS,
  );
}

function tradingBlueprintAddressForBlueprint(
  blueprint: TradingBlueprintDef | undefined,
): Address | undefined {
  if (!blueprint) return undefined;
  if (blueprint.isTee) {
    return (
      nonZeroAddress(import.meta.env.VITE_TEE_TRADING_BLUEPRINT) ??
      nonZeroAddress(import.meta.env.VITE_INSTANCE_TRADING_BLUEPRINT) ??
      nonZeroAddress(import.meta.env.VITE_TRADING_BLUEPRINT)
    );
  }
  if (!blueprint.isFleet) {
    return (
      nonZeroAddress(import.meta.env.VITE_INSTANCE_TRADING_BLUEPRINT) ??
      nonZeroAddress(import.meta.env.VITE_TRADING_BLUEPRINT)
    );
  }
  return nonZeroAddress(import.meta.env.VITE_TRADING_BLUEPRINT);
}

async function resolveInstanceVaultAddressForProvision(
  blueprint: TradingBlueprintDef | undefined,
  serviceId: bigint | number | string | undefined,
): Promise<Address | undefined> {
  if (!blueprint || blueprint.isFleet || serviceId == null) {
    return instanceVaultEnvAddressForBlueprint(blueprint);
  }

  const blueprintAddress = tradingBlueprintAddressForBlueprint(blueprint);
  if (blueprintAddress) {
    try {
      const vault = (await publicClient.readContract({
        address: blueprintAddress,
        abi: tradingBlueprintAbi,
        functionName: 'instanceVault',
        args: [BigInt(serviceId)],
      })) as Address;
      const resolved = nonZeroAddress(vault);
      if (resolved) return resolved;
    } catch (err) {
      console.warn(
        '[provision] Failed to resolve instance vault from blueprint:',
        err,
      );
    }
  }

  return instanceVaultEnvAddressForBlueprint(blueprint);
}

export function strategyUsesExecutionTarget(
  strategyType: string,
  target: DexExecutionTargetOption | undefined,
  _paperTrade = true,
): boolean {
  const pack = strategyPacks.find((p) => p.id === strategyType);
  if (pack?.executionMode !== 'single-chain') return false;
  if (!target) return false;
  const effectiveChainId = target.protocolChainId ?? target.chainId;
  return Boolean(
    effectiveChainId && pack.supportedChainIds.includes(effectiveChainId),
  );
}

function chainLabel(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

function formatSupportedChains(chainIds: number[]): string {
  return chainIds.map((id) => `${chainLabel(id)} (${id})`).join(', ');
}

export function executionTargetsForStrategy(
  strategyType: string,
  targets: DexExecutionTargetOption[],
): DexExecutionTargetOption[] {
  const pack = strategyPacks.find((p) => p.id === strategyType);
  if (!pack || pack.executionMode !== 'single-chain') return [];
  const supported = new Set(pack.supportedChainIds);
  return targets.filter((target) => {
    const effectiveChainId = target.protocolChainId ?? target.chainId;
    return effectiveChainId != null && supported.has(effectiveChainId);
  });
}

export function availableProtocolsForStrategyTarget(
  strategyType: string,
  target: DexExecutionTargetOption | undefined,
): string[] | undefined {
  const effectiveChainId = target?.protocolChainId ?? target?.chainId;
  if (strategyType === 'perp' && effectiveChainId === 42161) {
    return ['gmx_v2', 'vertex'];
  }
  if (
    strategyType === 'yield' &&
    (effectiveChainId === 1 || effectiveChainId === 8453)
  ) {
    return ['aave_v3', 'morpho_vault'];
  }
  return undefined;
}

export function validateStrategyExecutionSelection(
  strategyType: string,
  target: DexExecutionTargetOption | undefined,
  paperTrade: boolean,
): { ok: true } | { ok: false; message: string } {
  const pack = strategyPacks.find((p) => p.id === strategyType);
  if (!pack) {
    return {
      ok: false,
      message: 'Select a valid strategy profile before provisioning.',
    };
  }

  if (pack.executionMode === 'none') {
    return {
      ok: false,
      message: `${pack.name} requires multi-chain orchestration and cannot be provisioned from the single-chain flow yet.`,
    };
  }

  if (pack.executionMode === 'paper-only') {
    if (!paperTrade) {
      return {
        ok: false,
        message: `${pack.name} is paper-trading only until multi-chain execution is supported.`,
      };
    }
    return { ok: true };
  }

  if (!target) {
    return {
      ok: false,
      message: `${pack.name} supports ${formatSupportedChains(pack.supportedChainIds)}.`,
    };
  }

  const effectiveChainId = target.protocolChainId ?? target.chainId;
  if (!effectiveChainId || !pack.supportedChainIds.includes(effectiveChainId)) {
    return {
      ok: false,
      message: `${pack.name} supports ${formatSupportedChains(pack.supportedChainIds)}.`,
    };
  }
  if (!target.enabled) {
    return {
      ok: false,
      message: `${target.label} is supported for ${pack.name}, but it is not enabled in this deployment.`,
    };
  }

  return { ok: true };
}

export function buildServiceActivationAttemptKey(
  activatedServiceId: string,
  txHash?: `0x${string}`,
): string {
  return txHash
    ? `${txHash}:${activatedServiceId}`
    : `service:${activatedServiceId}`;
}

interface InstanceOperatorBot {
  id: string;
  sandbox_id: string;
  sandbox_exists: boolean;
  sandbox_state?: string | null;
  vault_address: string;
  strategy_type: string;
  trading_active: boolean;
  lifecycle_status: BotLifecycleStatus;
  archived?: boolean;
  control_available?: boolean;
  secrets_configured?: boolean;
  workflow_id?: string | number | null;
  call_id: number;
  service_id: number;
}

export function selectLatestInstanceProvision(
  provisions: TrackedProvision[],
  activeServiceId?: string,
  target: InstanceProvisionIdentity = {},
): TrackedProvision | undefined {
  const candidates = provisions.filter(
    (p) => p.id.startsWith('instance-') && p.phase !== 'failed',
  );
  if (candidates.length === 0) return undefined;

  const parsedServiceId =
    activeServiceId && /^\d+$/.test(activeServiceId)
      ? Number(activeServiceId)
      : undefined;

  const sortNewest = (a: TrackedProvision, b: TrackedProvision) =>
    b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;

  if (parsedServiceId != null) {
    const matching = candidates
      .filter((p) => p.serviceId === parsedServiceId)
      .sort(sortNewest);
    if (matching[0]) return matching[0];
  }

  const targetServiceId =
    typeof target.serviceId === 'number'
      ? target.serviceId
      : typeof target.serviceId === 'string' && /^\d+$/.test(target.serviceId)
        ? Number(target.serviceId)
        : undefined;

  if (targetServiceId != null) {
    const matching = candidates
      .filter((p) => p.serviceId === targetServiceId)
      .sort(sortNewest);
    if (matching[0]) return matching[0];
  }

  if (target.botId) {
    const matching = candidates
      .filter((p) => p.botId === target.botId)
      .sort(sortNewest);
    if (matching[0]) return matching[0];
  }

  if (target.sandboxId) {
    const matching = candidates
      .filter((p) => p.sandboxId === target.sandboxId)
      .sort(sortNewest);
    if (matching[0]) return matching[0];
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  return undefined;
}

export const meta: MetaFunction = () => [
  { title: 'Deploy Agent — AI Trading Arena' },
];

// ── Main page ────────────────────────────────────────────────────────────

export default function ProvisionPage() {
  const {
    address: userAddress,
    isConnected,
    chainId: walletChainId,
  } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const selectedChainId = useStore(selectedChainIdStore);
  const selectedNetwork = resolveSelectedProvisionNetwork(selectedChainId);
  if (!selectedNetwork) {
    throw new Error('No configured networks available for provisioning');
  }
  const targetChain = selectedNetwork.chain;
  const isWrongChain = isConnected && walletChainId !== targetChain.id;
  const localChainId = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);
  const executionTargets = useMemo<DexExecutionTargetOption[]>(() => {
    return [
      DEFAULT_BASE_EXECUTION_TARGET,
      DEFAULT_BASE_MAINNET_EXECUTION_TARGET,
      DEFAULT_ETHEREUM_EXECUTION_TARGET,
      DEFAULT_ETHEREUM_MAINNET_EXECUTION_TARGET,
      DEFAULT_ARBITRUM_FORK_EXECUTION_TARGET,
      DEFAULT_ARBITRUM_EXECUTION_TARGET,
      DEFAULT_ARBITRUM_ONE_EXECUTION_TARGET,
      DEFAULT_POLYGON_EXECUTION_TARGET,
      DEFAULT_OPTIMISM_EXECUTION_TARGET,
    ];
  }, []);
  const [executionTargetId, setExecutionTargetId] =
    useState<DexExecutionTargetId>(
      import.meta.env.VITE_FORK_MODE === 'true' ? 'ethereum' : 'base',
    );
  const configuredExecutionTarget = useMemo(
    () =>
      executionTargets.find((target) => target.id === executionTargetId) ??
      executionTargets[0],
    [executionTargetId, executionTargets],
  );
  const [provisionPaperTrade, setProvisionPaperTrade] = useState(
    configuredExecutionTarget?.paperTrade ?? false,
  );
  useEffect(() => {
    setProvisionPaperTrade(configuredExecutionTarget?.paperTrade ?? false);
  }, [configuredExecutionTarget?.id, configuredExecutionTarget?.paperTrade]);
  const localFeeOverrides = useMemo(
    () =>
      import.meta.env.VITE_USE_LOCAL_CHAIN === 'true' &&
      targetChain.id === localChainId
        ? {
            maxFeePerGas: parseGwei('1'),
            maxPriorityFeePerGas: parseGwei('1'),
          }
        : {},
    [targetChain.id, localChainId],
  );

  /** Ensure wallet is on tangleLocal before sending a TX. Returns true if ready. */
  const ensureCorrectChain = useCallback(async (): Promise<boolean> => {
    if (!isConnected) {
      toast.error('Connect wallet first');
      return false;
    }
    if (walletChainId === targetChain.id) return true;

    try {
      await switchChainAsync({ chainId: targetChain.id });
      return true;
    } catch (err: any) {
      if (err?.code === 4001) return false;
      toast.error(
        `Switch to ${targetChain.name} in your wallet (chain ${targetChain.id})`,
      );
      return false;
    }
  }, [
    isConnected,
    walletChainId,
    switchChainAsync,
    targetChain.id,
    targetChain.name,
  ]);

  // URL params for pre-selecting a blueprint or targeting an instance draft
  const [searchParams, setSearchParams] = useSearchParams();
  const preselectedBlueprintId = searchParams.get('blueprint');
  const targetServiceId = searchParams.get('serviceId');
  const targetBotId = searchParams.get('botId');
  const targetSandboxId = searchParams.get('sandboxId');

  // Blueprint selection state
  const initialBlueprint = preselectedBlueprintId
    ? (getBlueprint(preselectedBlueprintId) ?? TRADING_BLUEPRINTS[0])
    : TRADING_BLUEPRINTS.length === 1
      ? TRADING_BLUEPRINTS[0]
      : undefined;
  const skipBlueprintStep =
    TRADING_BLUEPRINTS.length <= 1 || !!preselectedBlueprintId;

  // Wizard navigation
  const [step, setStep] = useState<WizardStep>(
    skipBlueprintStep ? 'configure' : 'blueprint',
  );
  const [selectedBlueprint, setSelectedBlueprint] = useState<
    TradingBlueprintDef | undefined
  >(initialBlueprint);

  // Blueprint + service defaults
  const [blueprintId, setBlueprintId] = useState(
    () =>
      selectedBlueprint?.blueprintId ??
      import.meta.env.VITE_BLUEPRINT_ID ??
      '0',
  );
  const [serviceMode, setServiceMode] = useState<'existing' | 'new'>(
    'existing',
  );
  const [serviceId, setServiceId] = useState(() => {
    const raw = import.meta.env.VITE_SERVICE_IDS ?? '';
    const first = raw.split(',')[0].trim();
    return first && /^\d+$/.test(first) ? first : '0';
  });
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [showInfra, setShowInfra] = useState(false);
  const [discoveredServices, setDiscoveredServices] = useState<
    DiscoveredService[]
  >([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);

  // New service deployment
  const [selectedOperators, setSelectedOperators] = useState<Set<Address>>(
    new Set(),
  );
  const [manualOperator, setManualOperator] = useState('');
  const [newServiceTxHash, setNewServiceTxHash] = useState<
    `0x${string}` | undefined
  >();
  const [newServiceDeploying, setNewServiceDeploying] = useState(false);

  // Instance auto-provision state
  const [instanceProvisioning, setInstanceProvisioning] = useState(false);
  const [instanceProvisionError, setInstanceProvisionError] = useState<
    string | null
  >(null);
  const handledActivationAttemptKeysRef = useRef<Set<string>>(new Set());
  const instanceAutoProvisionInFlightRef = useRef<string | null>(null);
  const activationGuardTxHashRef = useRef<`0x${string}` | undefined>();
  const submitSnapshotRef = useRef<SubmitSnapshot | null>(null);
  const processedSubmitTxHashesRef = useRef<Set<`0x${string}`>>(new Set());
  const instanceRouteTarget = useMemo<InstanceProvisionIdentity>(
    () => ({
      serviceId: targetServiceId ?? undefined,
      botId: targetBotId ?? undefined,
      sandboxId: targetSandboxId ?? undefined,
    }),
    [targetBotId, targetSandboxId, targetServiceId],
  );
  const hasExplicitInstanceRouteTarget = Boolean(
    instanceRouteTarget.serviceId ||
    instanceRouteTarget.botId ||
    instanceRouteTarget.sandboxId,
  );

  // Configure — agent settings
  const [name, setName] = useState('');
  const [strategyType, setStrategyType] = useState('dex');
  const [runtimeBackend, setRuntimeBackend] =
    useState<RuntimeBackend>('docker');
  const [customInstructions, setCustomInstructions] = useState('');
  const [customExpertKnowledge, setCustomExpertKnowledge] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [customConversationCron, setCustomConversationCron] = useState('');
  const [customResearchCron, setCustomResearchCron] = useState('');
  const [conversationEnabled, setConversationEnabled] = useState(true);
  const [researchEnabled, setResearchEnabled] = useState(true);
  const [collateralCapPct, setCollateralCapPct] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validatorMode, setValidatorMode] = useState<'default' | 'custom'>(
    'default',
  );
  const [customValidatorIds, setCustomValidatorIds] = useState('');
  const [validationTrust, setValidationTrust] = useState<ValidationTrust>(
    'per_trade',
  );

  // Deploy step
  const {
    writeContract,
    data: txHash,
    isPending,
    reset: resetTx,
  } = useWriteContract();

  // Provisions store
  const ownerProvisions = useMemo(
    () => provisionsForOwner(userAddress),
    [userAddress],
  );
  const myProvisions = useStore(ownerProvisions) as TrackedProvision[];

  // Operator discovery
  const blueprintIdBig = useMemo(
    () => BigInt(blueprintId || '0'),
    [blueprintId],
  );
  const { operators: discoveredOperators, operatorCount } =
    useOperators(blueprintIdBig);

  // Quotes for new service mode
  const selectedOps = useMemo(
    () => discoveredOperators.filter((op) => selectedOperators.has(op.address)),
    [discoveredOperators, selectedOperators],
  );
  const ttlBlocks = useMemo(() => BigInt((30 * 86400) / 12), []);
  const quotesEnabled = selectedOperators.size > 0 && serviceMode === 'new';
  const {
    quotes,
    isLoading: isQuoting,
    errors: quoteErrors,
    totalCost,
    refetch: refetchQuotes,
  } = useQuotes(
    selectedOps,
    blueprintIdBig,
    ttlBlocks,
    quotesEnabled,
    PricingModelHint.SUBSCRIPTION,
    !!selectedBlueprint?.isTee,
    // tnt-core v0.13.0: bind quote to the connected wallet (the address that
    // will be `msg.sender` for `createServiceFromQuotes`). When undefined the
    // hook holds the fetch — `address(0)` is rejected on-chain.
    userAddress,
  );

  // Second writeContract for new service
  const { writeContract: writeNewService, isPending: isNewServicePending } =
    useWriteContract();

  // Secrets step state
  const defaultProvider = (
    DEFAULT_AI_PROVIDER === 'zai' || DEFAULT_AI_PROVIDER === 'tangle-router'
      ? DEFAULT_AI_PROVIDER
      : 'anthropic'
  ) as AiProvider;
  const [aiProvider, setAiProvider] = useState<AiProvider>(defaultProvider);
  const [apiKey, setApiKey] = useState(DEFAULT_AI_API_KEY);
  const [extraEnvs, setExtraEnvs] = useState<
    { id: number; key: string; value: string }[]
  >([]);
  const envIdRef = useRef(0);
  const [isSubmittingSecrets, setIsSubmittingSecrets] = useState(false);
  const [activationPhase, setActivationPhase] = useState<string | null>(null);
  const [secretsLookupError, setSecretsLookupError] = useState<string | null>(
    null,
  );
  const [useOperatorKey, setUseOperatorKey] = useState(false);

  const selectedPack = strategyPacks.find((p) => p.id === strategyType)!;
  const compatibleExecutionTargets = useMemo(
    () => executionTargetsForStrategy(strategyType, executionTargets),
    [strategyType, executionTargets],
  );
  const enabledCompatibleExecutionTargets = useMemo(
    () => compatibleExecutionTargets.filter((target) => target.enabled),
    [compatibleExecutionTargets],
  );
  const selectedExecutionTarget = useMemo(() => {
    if (selectedPack.executionMode !== 'single-chain') return undefined;
    return (
      compatibleExecutionTargets.find(
        (target) => target.id === executionTargetId && target.enabled,
      ) ??
      enabledCompatibleExecutionTargets[0] ??
      compatibleExecutionTargets.find(
        (target) => target.id === executionTargetId,
      ) ??
      compatibleExecutionTargets[0]
    );
  }, [
    compatibleExecutionTargets,
    enabledCompatibleExecutionTargets,
    executionTargetId,
    selectedPack.executionMode,
  ]);
  const strategyExecutionValidation = validateStrategyExecutionSelection(
    strategyType,
    selectedExecutionTarget,
    provisionPaperTrade,
  );
  const hasEnabledExecutionTarget =
    selectedPack.executionMode !== 'single-chain' ||
    enabledCompatibleExecutionTargets.length > 0;
  const strategyExecutionNotice = (() => {
    if (selectedPack.executionMode === 'paper-only') {
      return `${selectedPack.name} is paper-trading only until multi-chain execution is supported.`;
    }
    if (selectedPack.executionMode === 'none') {
      return `${selectedPack.name} requires multi-chain orchestration and cannot be provisioned from this single-chain flow yet.`;
    }
    if (enabledCompatibleExecutionTargets.length === 0) {
      return `${selectedPack.name} supports ${formatSupportedChains(selectedPack.supportedChainIds)}, but none are enabled in this deployment.`;
    }
    if (!selectedExecutionTarget?.enabled) {
      return `${selectedPack.name} supports ${formatSupportedChains(selectedPack.supportedChainIds)}. Enable one of those targets in the deployment config.`;
    }
    return null;
  })();
  const effectiveExpert = customExpertKnowledge || selectedPack.expertKnowledge;
  const effectiveCron = customCron || selectedPack.cron;
  const effectiveConversationCron =
    customConversationCron ||
    selectedPack.conversationCron ||
    '0 1,6,11,16,21,26,31,36,41,46,51,56 * * * *';
  const effectiveResearchCron =
    customResearchCron ||
    selectedPack.researchCron ||
    '0 2 0,2,4,6,8,10,12,14,16,18,20,22 * * *';
  const fullInstructions = buildFullInstructions(effectiveExpert, strategyType);
  const isInstance = selectedBlueprint ? !selectedBlueprint.isFleet : false;

  // Reset customizations when strategy changes
  const prevStrategyRef = useRef(strategyType);
  useEffect(() => {
    if (prevStrategyRef.current === strategyType) return;
    prevStrategyRef.current = strategyType;
    setCustomExpertKnowledge('');
    setCustomInstructions('');
    setCustomCron('');
    setCustomConversationCron('');
    setCustomResearchCron('');
    setConversationEnabled(true);
    setResearchEnabled(true);
  }, [strategyType]);

  // Auto-set service mode to 'new' for instance blueprints
  useEffect(() => {
    if (isInstance) setServiceMode('new');
  }, [isInstance]);

  useEffect(() => {
    if (selectedPack.executionMode !== 'single-chain') return;
    const selected = compatibleExecutionTargets.find(
      (target) => target.id === executionTargetId,
    );
    if (selected?.enabled) return;
    const firstEnabled = enabledCompatibleExecutionTargets[0];
    if (firstEnabled) setExecutionTargetId(firstEnabled.id);
  }, [
    compatibleExecutionTargets,
    enabledCompatibleExecutionTargets,
    executionTargetId,
    selectedPack.executionMode,
  ]);

  useEffect(() => {
    if (selectedPack.executionMode === 'paper-only' && !provisionPaperTrade) {
      setProvisionPaperTrade(true);
    }
  }, [provisionPaperTrade, selectedPack.executionMode]);

  useEffect(() => {
    if (selectedBlueprint?.isTee) {
      setRuntimeBackend('tee');
    } else if (runtimeBackend === 'tee') {
      setRuntimeBackend('docker');
    }
  }, [runtimeBackend, selectedBlueprint?.id, selectedBlueprint?.isTee]);

  useEffect(() => {
    if (FIRECRACKER_RUNTIME_SUPPORTED || runtimeBackend !== 'firecracker')
      return;
    setRuntimeBackend(selectedBlueprint?.isTee ? 'tee' : 'docker');
  }, [runtimeBackend, selectedBlueprint?.isTee]);

  useEffect(() => {
    if (!isInstance || serviceMode !== 'new' || selectedOperators.size > 0)
      return;
    const defaultOperator = discoveredOperators[0]?.address;
    if (!defaultOperator) return;
    setSelectedOperators(new Set([defaultOperator]));
  }, [discoveredOperators, isInstance, selectedOperators.size, serviceMode]);

  const resetServiceActivationGuard = useCallback((txHash?: `0x${string}`) => {
    activationGuardTxHashRef.current = txHash;
    handledActivationAttemptKeysRef.current = new Set();
    instanceAutoProvisionInFlightRef.current = null;
  }, []);

  useEffect(() => {
    if (activationGuardTxHashRef.current === newServiceTxHash) return;
    resetServiceActivationGuard(newServiceTxHash);
  }, [newServiceTxHash, resetServiceActivationGuard]);

  // Reset new service deploying state when switching modes
  useEffect(() => {
    if (serviceMode !== 'new') {
      setNewServiceDeploying(false);
      resetServiceActivationGuard(undefined);
    }
  }, [serviceMode, resetServiceActivationGuard]);

  // Track TX in history + create provision entry
  useEffect(() => {
    if (!txHash || processedSubmitTxHashesRef.current.has(txHash)) return;
    const snapshot = submitSnapshotRef.current;
    const owner = snapshot?.owner ?? userAddress;
    if (!owner) return;
    const provisionName = snapshot?.name || name || 'Agent';
    const packName = snapshot?.selectedPackName ?? selectedPack?.name;
    const chainId = snapshot?.targetChainId ?? targetChain.id;
    addTx(
      txHash,
      `Deploy ${provisionName} (${packName})`,
      chainId,
    );
    addProvision({
      id: txHash,
      owner,
      name: provisionName,
      strategyType: snapshot?.strategyType ?? strategyType,
      operators: snapshot?.operators ?? serviceInfo?.operators ?? [],
      blueprintId: snapshot?.blueprintId ?? blueprintId,
      blueprintType: snapshot?.blueprintType ?? selectedBlueprint?.id,
      txHash,
      serviceId:
        snapshot?.serviceId ?? (serviceInfo ? Number(serviceId) : undefined),
      jobIndex: 0,
      phase: 'pending_confirmation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chainId,
    });
    processedSubmitTxHashesRef.current.add(txHash);
  }, [
    blueprintId,
    name,
    selectedBlueprint?.id,
    selectedPack?.name,
    serviceId,
    serviceInfo,
    strategyType,
    targetChain.id,
    txHash,
    userAddress,
  ]);

  const latestDeployment = useMemo(() => {
    const txMatch = myProvisions.find((p) => p.txHash === txHash);
    if (txMatch) return txMatch;
    if (isInstance) {
      return selectLatestInstanceProvision(
        myProvisions,
        serviceId,
        instanceRouteTarget,
      );
    }
    return undefined;
  }, [instanceRouteTarget, isInstance, myProvisions, serviceId, txHash]);

  const ambiguousInstanceProvisionMessage = useMemo(() => {
    if (!isInstance || latestDeployment || hasExplicitInstanceRouteTarget)
      return null;
    const candidates = myProvisions.filter(
      (p) => p.id.startsWith('instance-') && p.phase !== 'failed',
    );
    if (candidates.length <= 1) return null;
    return 'Multiple instance bot drafts exist for this wallet. Open the intended bot from the dashboard or use a route with serviceId, botId, or sandboxId so the correct draft is resumed.';
  }, [
    hasExplicitInstanceRouteTarget,
    isInstance,
    latestDeployment,
    myProvisions,
  ]);

  const syncInstanceRouteTarget = useCallback(
    (target: InstanceProvisionIdentity) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (target.serviceId != null) {
            next.set('serviceId', String(target.serviceId));
          } else {
            next.delete('serviceId');
          }
          if (target.botId) {
            next.set('botId', target.botId);
          } else {
            next.delete('botId');
          }
          if (target.sandboxId) {
            next.set('sandboxId', target.sandboxId);
          } else {
            next.delete('sandboxId');
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const currentInstanceIdentity = useMemo<InstanceProvisionIdentity>(
    () => ({
      serviceId: latestDeployment?.serviceId ?? instanceRouteTarget.serviceId,
      botId: latestDeployment?.botId ?? instanceRouteTarget.botId,
      sandboxId: latestDeployment?.sandboxId ?? instanceRouteTarget.sandboxId,
    }),
    [
      instanceRouteTarget.botId,
      instanceRouteTarget.sandboxId,
      instanceRouteTarget.serviceId,
      latestDeployment?.botId,
      latestDeployment?.sandboxId,
      latestDeployment?.serviceId,
    ],
  );

  const operatorApiUrl = useMemo(
    () =>
      getOperatorApiUrlForBlueprint(
        selectedBlueprint?.id ?? latestDeployment?.blueprintType,
      ),
    [latestDeployment?.blueprintType, selectedBlueprint?.id],
  );
  const operatorAuth = useOperatorAuth(operatorApiUrl);
  const { data: operatorMeta } = useOperatorMeta(operatorApiUrl);
  const expectedOperatorKind = useMemo(
    () =>
      getExpectedDeploymentKindForBlueprint(
        selectedBlueprint?.id ?? latestDeployment?.blueprintType,
      ),
    [latestDeployment?.blueprintType, selectedBlueprint?.id],
  );
  const operatorRouteMismatchMessage = useMemo(() => {
    if (!operatorMeta || operatorMeta.deployment_kind === expectedOperatorKind)
      return null;
    const flowLabel = expectedOperatorKind === 'fleet' ? 'cloud' : 'instance';
    return `This ${flowLabel} provision flow is pointed at a ${operatorMeta.deployment_kind} operator. Fix the local operator proxy routing and restart the devnet.`;
  }, [expectedOperatorKind, operatorMeta]);
  const hasOperatorManagedProvision = myProvisions.some((p) =>
    ['job_submitted', 'job_processing', 'awaiting_secrets'].includes(p.phase),
  );
  const provisionNeedsOperatorAuth = Boolean(
    operatorApiUrl &&
    isConnected &&
    (isInstance ||
      step === 'deploy' ||
      step === 'secrets' ||
      instanceProvisioning ||
      hasOperatorManagedProvision),
  );

  useRouteOperatorAutoAuth({
    enabled: provisionNeedsOperatorAuth,
    routeKey: 'provision',
    apiUrl: operatorApiUrl,
  });

  const handleInstanceProvisionSuccess = useCallback(
    (
      activatedServiceId: string,
      result: { bot_id: string; sandbox_id: string },
    ) => {
      if (instanceAutoProvisionInFlightRef.current === activatedServiceId) {
        instanceAutoProvisionInFlightRef.current = null;
      }
      setInstanceProvisioning(false);
      setServiceId(activatedServiceId);
      syncInstanceRouteTarget({
        serviceId: activatedServiceId,
        botId: result.bot_id,
        sandboxId: result.sandbox_id,
      });

      if (userAddress) {
        upsertInstanceProvision({
          id: `instance-${activatedServiceId}`,
          owner: userAddress,
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
          botId: result.bot_id,
          sandboxId: result.sandbox_id,
          callId: 0,
        });
      }

      resetTx();
      toast.success(
        `Instance provisioned! Configure API keys to start trading.`,
      );
      setStep('secrets');
    },
    [
      userAddress,
      name,
      strategyType,
      blueprintId,
      selectedBlueprint?.id,
      targetChain.id,
      resetTx,
      syncInstanceRouteTarget,
    ],
  );

  // Auto-provision instance bot via operator API after service activation
  const autoProvisionInstance = useCallback(
    async (activatedServiceId: string) => {
      if (instanceAutoProvisionInFlightRef.current === activatedServiceId)
        return;

      instanceAutoProvisionInFlightRef.current = activatedServiceId;
      setInstanceProvisioning(true);
      setInstanceProvisionError(null);

      const maxRetries = 5;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          let authToken = operatorAuth.token;
          if (!authToken) {
            authToken = await operatorAuth.authenticate();
            if (!authToken) throw new Error('Wallet authentication failed');
          }

          const resolvedValidatorIds = resolveValidatorServiceIds({
            validatorMode,
            customValidatorIds,
            defaultValidatorServiceId: import.meta.env.VITE_VALIDATOR_SERVICE_ID,
          });
          if (!resolvedValidatorIds.ok) {
            throw new Error(resolvedValidatorIds.message);
          }

          const strategyExecution = validateStrategyExecutionSelection(
            strategyType,
            selectedExecutionTarget,
            provisionPaperTrade,
          );
          if (!strategyExecution.ok) {
            throw new Error(strategyExecution.message);
          }

          const usesExecutionTarget = strategyUsesExecutionTarget(
            strategyType,
            selectedExecutionTarget,
            provisionPaperTrade,
          );
          const executionConfig = resolveExecutionTargetProvisionConfig(
            selectedExecutionTarget,
          );
          if (usesExecutionTarget && !executionConfig) {
            throw new Error('Execution target is incomplete');
          }
          const instanceVaultAddress =
            selectedBlueprint && !selectedBlueprint.isFleet
              ? await resolveInstanceVaultAddressForProvision(
                  selectedBlueprint,
                  activatedServiceId,
                )
              : undefined;

          const provisionBody = buildOperatorProvisionBody({
            name,
            fallbackName: `Instance Bot (service ${activatedServiceId})`,
            strategyType,
            runtimeBackend,
            isTeeBlueprint: !!selectedBlueprint?.isTee,
            customExpertKnowledge,
            customInstructions,
            paperTrade: provisionPaperTrade,
            selectedExecutionTarget,
            includeExecutionTarget: usesExecutionTarget,
            executionConfig,
            conversationCron: effectiveConversationCron,
            researchCron: effectiveResearchCron,
            conversationEnabled,
            researchEnabled,
            effectiveCron,
            validatorServiceIds: resolvedValidatorIds.ids,
            vaultAddress: instanceVaultAddress,
            validationTrust,
          });

          const res = await fetch(`${operatorApiUrl}/api/bot/provision`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify(provisionBody),
          });

          if (res.status === 401) {
            operatorAuth.clearCachedToken();
            const fresh = await operatorAuth.authenticate();
            if (!fresh) throw new Error('Re-authentication failed');
            const retry = await fetch(`${operatorApiUrl}/api/bot/provision`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${fresh}`,
              },
              body: JSON.stringify(provisionBody),
            });
            if (!retry.ok) throw await readOperatorError(retry);
            const result = await retry.json();
            handleInstanceProvisionSuccess(activatedServiceId, result);
            return;
          }

          if (!res.ok) {
            throw await readOperatorError(res);
          }

          const result = await res.json();
          handleInstanceProvisionSuccess(activatedServiceId, result);
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          if (attempt < maxRetries - 1) {
            await new Promise((r) =>
              setTimeout(r, 2000 * Math.pow(2, attempt)),
            );
            continue;
          }
          setInstanceProvisionError(msg);
          toast.error(`Instance provision failed: ${msg.slice(0, 150)}`);
        }
      }
      setInstanceProvisioning(false);
      if (instanceAutoProvisionInFlightRef.current === activatedServiceId) {
        instanceAutoProvisionInFlightRef.current = null;
      }
    },
    [
      name,
      strategyType,
      runtimeBackend,
      selectedBlueprint?.isTee,
      effectiveCron,
      effectiveConversationCron,
      effectiveResearchCron,
      conversationEnabled,
      researchEnabled,
      validatorMode,
      customValidatorIds,
      validationTrust,
      customExpertKnowledge,
      customInstructions,
      operatorApiUrl,
      operatorAuth,
      selectedExecutionTarget,
      provisionPaperTrade,
      handleInstanceProvisionSuccess,
    ],
  );

  // ── Service validation ─────────────────────────────────────────────────

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
        err instanceof Error
          ? err.message.slice(0, 120)
          : 'Failed to fetch service',
      );
    } finally {
      setServiceLoading(false);
    }
  }, [serviceId, userAddress]);

  useEffect(() => {
    if (serviceMode === 'existing') validateService();
  }, [serviceId, serviceMode, validateService]);

  useEffect(() => {
    if (serviceInfo) {
      const mismatch = serviceInfo.blueprintId !== Number(blueprintId);
      if (serviceInfo.blueprintMismatch !== mismatch) {
        setServiceInfo((prev) =>
          prev ? { ...prev, blueprintMismatch: mismatch } : prev,
        );
      }
    }
  }, [blueprintId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Service discovery ──────────────────────────────────────────────────

  const discoverServices = useCallback(async () => {
    if (!userAddress) return;
    setDiscoveryLoading(true);
    try {
      let fromBlock = 0n;
      try {
        const latestBlock = await publicClient.getBlockNumber();
        const lookback = 250_000n;
        fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
      } catch {
        /* fall back to genesis */
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

      type SvcLog = { args: { serviceId?: bigint } };
      const serviceIds: number[] = logs.map((log: SvcLog) =>
        Number(log.args.serviceId!),
      );
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
            const isOwner =
              svc.owner.toLowerCase() === userAddress.toLowerCase();

            return {
              serviceId: sid,
              isActive,
              isPermitted: isPermitted || isOwner,
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
      valid.sort((a, b) => {
        const scoreA =
          (a.isActive && a.isPermitted ? 4 : 0) +
          (a.isActive ? 2 : 0) +
          (a.isOwner ? 1 : 0);
        const scoreB =
          (b.isActive && b.isPermitted ? 4 : 0) +
          (b.isActive ? 2 : 0) +
          (b.isOwner ? 1 : 0);
        return scoreB - scoreA;
      });
      setDiscoveredServices(valid);

      const best = valid.find((s) => s.isActive && s.isPermitted);
      if (best) setServiceId(best.serviceId.toString());
    } catch {
      // Discovery is best-effort
    } finally {
      setDiscoveryLoading(false);
    }
  }, [blueprintId, userAddress]);

  const handleServiceActivated = useCallback(
    (activatedServiceId: string) => {
      const activationKey = buildServiceActivationAttemptKey(
        activatedServiceId,
        newServiceTxHash,
      );
      if (handledActivationAttemptKeysRef.current.has(activationKey)) return;

      handledActivationAttemptKeysRef.current.add(activationKey);
      setNewServiceDeploying(false);
      setShowInfra(false);

      if (isInstance) {
        toast.success(
          `Service #${activatedServiceId} active! Provisioning instance bot...`,
        );
        void autoProvisionInstance(activatedServiceId);
      } else {
        setServiceId(activatedServiceId);
        setServiceMode('existing');
        toast.success(
          `Service #${activatedServiceId} is live! Ready to provision agents.`,
        );
        void discoverServices();
      }
    },
    [isInstance, autoProvisionInstance, discoverServices, newServiceTxHash],
  );

  // Wait for new service TX receipt
  useEffect(() => {
    if (!newServiceTxHash || !newServiceDeploying) return;
    publicClient
      .waitForTransactionReceipt({ hash: newServiceTxHash })
      .then(
        (receipt: {
          status: string;
          logs?: Array<{
            data: `0x${string}`;
            topics: readonly `0x${string}`[];
          }>;
        }) => {
          if (receipt.status === 'success') {
            for (const log of receipt.logs ?? []) {
              try {
                const decoded = decodeEventLog({
                  abi: tangleServicesAbi,
                  data: log.data,
                  topics: [...log.topics] as [
                    `0x${string}`,
                    ...`0x${string}`[],
                  ],
                });
                if (decoded.eventName !== 'ServiceActivated') continue;
                const args = decoded.args as {
                  blueprintId?: bigint;
                  serviceId?: bigint;
                };
                if (args.blueprintId == null || args.serviceId == null)
                  continue;
                if (Number(args.blueprintId) !== Number(blueprintId)) continue;
                handleServiceActivated(Number(args.serviceId).toString());
                return;
              } catch {
                // Ignore unrelated logs in the receipt
              }
            }

            toast.success(
              'Service request submitted! Waiting for activation...',
            );
          } else {
            toast.error('Service request transaction reverted');
            resetServiceActivationGuard(undefined);
            setNewServiceDeploying(false);
          }
        },
      )
      .catch(() => {
        toast.error('Failed to confirm service request');
        resetServiceActivationGuard(undefined);
        setNewServiceDeploying(false);
      });
  }, [
    newServiceTxHash,
    newServiceDeploying,
    blueprintId,
    handleServiceActivated,
    resetServiceActivationGuard,
  ]);

  // Watch for ServiceActivated when deploying new service
  useEffect(() => {
    if (!newServiceDeploying) return;
    const unwatch = publicClient.watchContractEvent({
      address: addresses.tangle,
      abi: tangleServicesAbi,
      eventName: 'ServiceActivated',
      onLogs(
        logs: Array<{ args: { blueprintId?: bigint; serviceId?: bigint } }>,
      ) {
        for (const log of logs) {
          const bid = log.args.blueprintId;
          const sid = log.args.serviceId;
          if (bid == null || sid == null) continue;
          if (Number(bid) === Number(blueprintId)) {
            handleServiceActivated(Number(sid).toString());
          }
        }
      },
    });
    return unwatch;
  }, [newServiceDeploying, blueprintId, handleServiceActivated]);

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
      toast.error(
        'Service is not active — select an active service in Infrastructure Settings',
      );
      return;
    }
    if (!serviceInfo?.isPermitted) {
      toast.error('Your wallet is not a permitted caller on this service');
      return;
    }

    const strategyExecution = validateStrategyExecutionSelection(
      strategyType,
      selectedExecutionTarget,
      provisionPaperTrade,
    );
    if (!strategyExecution.ok) {
      toast.error(strategyExecution.message);
      return;
    }

    const requiresExecutionTarget = strategyUsesExecutionTarget(
      strategyType,
      selectedExecutionTarget,
      provisionPaperTrade,
    );
    const executionConfig = resolveExecutionTargetProvisionConfig(
      selectedExecutionTarget,
    );
    if (requiresExecutionTarget && !executionConfig) {
      toast.error(
        'Execution target is incomplete — select a valid execution target in Advanced Settings',
      );
      return;
    }

    const strategyConfig = buildProvisionStrategyConfig({
      strategyType,
      runtimeBackend,
      isTeeBlueprint: !!selectedBlueprint?.isTee,
      customExpertKnowledge,
      customInstructions,
      paperTrade: provisionPaperTrade,
      selectedExecutionTarget,
      includeExecutionTarget: requiresExecutionTarget,
      executionConfig,
      conversationCron: effectiveConversationCron,
      researchCron: effectiveResearchCron,
      conversationEnabled,
      researchEnabled,
    });

    const bp = selectedBlueprint ?? TRADING_BLUEPRINTS[0];

    const resolvedValidatorIds = resolveValidatorServiceIds({
      validatorMode,
      customValidatorIds,
      defaultValidatorServiceId: import.meta.env.VITE_VALIDATOR_SERVICE_ID,
    });
    if (!resolvedValidatorIds.ok) {
      toast.error(resolvedValidatorIds.message);
      return;
    }

    let vaultSigners: Address[] = [];
    if (resolvedValidatorIds.ids.length > 0) {
      try {
        const operatorResults = await Promise.all(
          resolvedValidatorIds.ids.map((vid) =>
            publicClient.readContract({
              address: addresses.tangle,
              abi: tangleServicesAbi,
              functionName: 'getServiceOperators',
              args: [vid],
            }),
          ),
        );
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
          toast.error(
            'Selected validator services have no operators — cannot create vault signers',
          );
          return;
        }
      } catch (err) {
        console.error(
          '[provision] Failed to resolve validator operators:',
          err,
        );
        toast.error('Failed to query validator service operators from chain');
        return;
      }
    }
    if (
      requiresExecutionTarget &&
      executionConfig?.vaultBinding === 'factory' &&
      !executionConfig.paperTrade &&
      vaultSigners.length < 2
    ) {
      toast.error(
        'Factory vault creation needs at least 2 validator operators',
      );
      return;
    }

    const inputs = bp.encodeProvision({
      name,
      strategyType,
      strategyConfig,
      riskParams: '{}',
      vaultAddress: executionConfig?.provisionVaultAddress ?? zeroAddress,
      assetAddress:
        executionConfig?.assetAddress ??
        ((import.meta.env.VITE_USDC_ADDRESS ??
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') as Address),
      depositors: vaultSigners.length > 0 ? vaultSigners : [],
      chainId: executionConfig?.chainId ?? BigInt(targetChain.id),
      rpcUrl: executionConfig?.rpcUrl ?? '',
      cron: effectiveCron,
      cpuCores: bp.defaults.cpuCores,
      memoryMb: bp.defaults.memoryMb,
      maxLifetimeDays: bp.defaults.maxLifetimeDays,
      validatorServiceIds: resolvedValidatorIds.ids,
      maxCollateralBps: collateralCapPct
        ? BigInt(Math.round(Number(collateralCapPct) * 100))
        : 0n,
    });

    submitSnapshotRef.current = {
      name: name || 'Agent',
      selectedPackName: selectedPack.name,
      targetChainId: targetChain.id,
      owner: userAddress,
      strategyType,
      operators: serviceInfo?.operators ?? [],
      blueprintId,
      blueprintType: selectedBlueprint?.id,
      serviceId: serviceInfo ? Number(serviceId) : undefined,
    };

    writeContract(
      {
        address: addresses.tangle,
        abi: tangleJobsAbi,
        functionName: 'submitJob',
        args: [BigInt(serviceId), 0, inputs],
        ...localFeeOverrides,
      },
      {
        onError(err) {
          const msg = err.message || '';
          const shortName = (err as any).shortMessage || '';
          if (msg.includes('NotPermittedCaller') || msg.includes('d5dd5b44')) {
            toast.error(
              'Not permitted — your wallet is not a permitted caller for this service',
            );
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
    const strategyExecution = validateStrategyExecutionSelection(
      strategyType,
      selectedExecutionTarget,
      provisionPaperTrade,
    );
    if (!strategyExecution.ok) {
      toast.error(strategyExecution.message);
      return;
    }
    if (quotes.length === 0) {
      toast.error('No quotes available — select operators first');
      return;
    }

    let instanceValidatorIds: bigint[] = [];
    let instanceVaultSigners: Address[] = [];
    if (isInstance) {
      const resolvedValidatorIds = resolveValidatorServiceIds({
        validatorMode,
        customValidatorIds,
        defaultValidatorServiceId: import.meta.env.VITE_VALIDATOR_SERVICE_ID,
      });
      if (!resolvedValidatorIds.ok) {
        toast.error(resolvedValidatorIds.message);
        return;
      }
      instanceValidatorIds = resolvedValidatorIds.ids;

      if (instanceValidatorIds.length > 0) {
        try {
          const opResults = await Promise.all(
            instanceValidatorIds.map((vid) =>
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
          console.warn(
            '[provision] Failed to resolve validator operators for instance vault:',
            err,
          );
        }
      }
    }

    const bp = selectedBlueprint ?? TRADING_BLUEPRINTS[0];
    // Convert collateral cap percentage (0-100) to basis points (0-10000)
    const collateralBps = collateralCapPct
      ? BigInt(Math.round(Number(collateralCapPct) * 100))
      : 0n;

    const config = buildInstanceServiceConfig({
      isInstance,
      name,
      strategyType,
      runtimeBackend,
      isTeeBlueprint: !!selectedBlueprint?.isTee,
      customExpertKnowledge,
      customInstructions,
      conversationCron: effectiveConversationCron,
      researchCron: effectiveResearchCron,
      conversationEnabled,
      researchEnabled,
      effectiveCron,
      validatorServiceIds: instanceValidatorIds,
      vaultSigners: instanceVaultSigners,
      collateralBps,
      targetChainId: targetChain.id,
      assetAddress: (import.meta.env.VITE_USDC_ADDRESS ??
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') as Address,
      blueprintDefaults: bp.defaults,
      validationTrust,
    });

    const quoteTuples = quotes.map((q) => ({
      details: {
        // tnt-core v0.13.0: `requester` is the FIRST field of the on-chain
        // tuple. Must match `msg.sender` and the operator's signed value.
        requester: q.details.requester,
        blueprintId: q.details.blueprintId,
        ttlBlocks: q.details.ttlBlocks,
        totalCost: q.details.totalCost,
        timestamp: q.details.timestamp,
        expiry: q.details.expiry,
        confidentiality: q.details.confidentiality,
        securityCommitments: q.details.securityCommitments.map((sc) => ({
          asset: { kind: sc.asset.kind, token: sc.asset.token },
          exposureBps: sc.exposureBps,
        })),
        resourceCommitments: q.details.resourceCommitments.map((resource) => ({
          kind: resource.kind,
          count: resource.count,
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
        args: [
          BigInt(blueprintId),
          quoteTuples,
          config,
          [userAddress],
          ttlBlocks,
        ],
        value: totalCost,
        ...localFeeOverrides,
      },
      {
        onSuccess(hash) {
          resetServiceActivationGuard(hash);
          setNewServiceTxHash(hash);
          setNewServiceDeploying(true);
        },
        onError(err) {
          toast.error(`New service failed: ${err.message.slice(0, 120)}`);
          resetServiceActivationGuard(undefined);
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
        return (
          !!name.trim() &&
          (FIRECRACKER_RUNTIME_SUPPORTED || runtimeBackend !== 'firecracker') &&
          strategyExecutionValidation.ok &&
          hasEnabledExecutionTarget
        );
      case 'deploy':
        return false;
    }
  })();

  const goNext = () => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) {
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

  const syncInstanceProvisionFromBot = useCallback(
    (bot: InstanceOperatorBot) => {
      if (!userAddress) return null;
      const phase =
        bot.lifecycle_status === 'awaiting_secrets' ||
        bot.secrets_configured === false
          ? 'awaiting_secrets'
          : 'active';

      const normalized: TrackedProvision = {
        id: `instance-${bot.service_id}`,
        owner: userAddress,
        name: latestDeployment?.name || name || 'Instance Agent',
        strategyType:
          bot.strategy_type || latestDeployment?.strategyType || strategyType,
        operators: latestDeployment?.operators ?? [],
        blueprintId: latestDeployment?.blueprintId ?? blueprintId,
        blueprintType: latestDeployment?.blueprintType ?? selectedBlueprint?.id,
        serviceId: bot.service_id,
        jobIndex: latestDeployment?.jobIndex ?? 0,
        phase,
        createdAt: latestDeployment?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        chainId: latestDeployment?.chainId ?? targetChain.id,
        botId: bot.id,
        sandboxId: bot.sandbox_id,
        callId: bot.call_id,
        workflowId: normalizeWorkflowId(bot.workflow_id),
        vaultAddress:
          bot.vault_address !== zeroAddress ? bot.vault_address : undefined,
      };

      upsertInstanceProvision(normalized);
      syncInstanceRouteTarget({
        serviceId: normalized.serviceId,
        botId: normalized.botId,
        sandboxId: normalized.sandboxId,
      });
      setSecretsLookupError(null);
      return normalized;
    },
    [
      blueprintId,
      latestDeployment,
      name,
      selectedBlueprint?.id,
      strategyType,
      syncInstanceRouteTarget,
      targetChain.id,
      userAddress,
    ],
  );

  const reconcileInstanceDeployment = useCallback(
    async (
      token: string,
    ): Promise<
      | { kind: 'ok'; provision: TrackedProvision }
      | { kind: 'auth_required' }
      | { kind: 'missing'; message: string }
      | { kind: 'error'; message: string }
    > => {
      if (
        !isInstance ||
        !userAddress ||
        operatorMeta?.deployment_kind !== 'instance'
      ) {
        if (!latestDeployment) {
          return {
            kind: 'error',
            message: 'No provision is available to configure.',
          };
        }
        return { kind: 'ok', provision: latestDeployment };
      }

      try {
        const res = await fetch(`${operatorApiUrl}/api/bot`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (res.status === 401 || res.status === 403) {
          return { kind: 'auth_required' };
        }

        if (res.status === 404) {
          removeMatchingInstanceProvision(userAddress, currentInstanceIdentity);
          return {
            kind: 'missing',
            message:
              'Instance bot is no longer provisioned on the operator. Reprovision it from the deploy step.',
          };
        }

        if (!res.ok) {
          return {
            kind: 'error',
            message: `Failed to load current instance bot (HTTP ${res.status}).`,
          };
        }

        const bot = (await res.json()) as InstanceOperatorBot;
        if (
          !bot.sandbox_exists ||
          bot.lifecycle_status === 'archived' ||
          bot.archived
        ) {
          removeMatchingInstanceProvision(userAddress, {
            serviceId: bot.service_id || currentInstanceIdentity.serviceId,
            botId: bot.id || currentInstanceIdentity.botId,
            sandboxId: bot.sandbox_id || currentInstanceIdentity.sandboxId,
          });
          return {
            kind: 'missing',
            message: `Instance bot ${bot.id} points to missing sandbox ${bot.sandbox_id}. Reprovision it from the deploy step.`,
          };
        }
        const provision = syncInstanceProvisionFromBot(bot);
        if (!provision) {
          return {
            kind: 'error',
            message: 'Wallet authentication required to load bot data.',
          };
        }
        return { kind: 'ok', provision };
      } catch {
        return {
          kind: 'error',
          message:
            'Failed to reach the operator while loading the current instance bot.',
        };
      }
    },
    [
      isInstance,
      userAddress,
      operatorMeta?.deployment_kind,
      latestDeployment,
      operatorApiUrl,
      currentInstanceIdentity,
      syncInstanceProvisionFromBot,
    ],
  );

  useEffect(() => {
    if (latestDeployment?.phase === 'awaiting_secrets' && step === 'deploy') {
      setStep('secrets');
    }
  }, [latestDeployment?.phase, step]);

  useEffect(() => {
    if (
      !isInstance ||
      step !== 'secrets' ||
      operatorMeta?.deployment_kind !== 'instance' ||
      !operatorAuth.token
    ) {
      return;
    }

    let cancelled = false;
    (async () => {
      const result = await reconcileInstanceDeployment(operatorAuth.token!);
      if (cancelled) return;
      if (result.kind === 'missing') {
        setSecretsLookupError(result.message);
        setStep('configure');
      } else if (result.kind === 'error') {
        setSecretsLookupError(result.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isInstance,
    step,
    operatorMeta?.deployment_kind,
    operatorAuth.token,
    reconcileInstanceDeployment,
  ]);

  /** Resolve operator bot ID using multi-strategy lookup. */
  const resolveBotId = useCallback(
    async (opts: {
      botId?: string;
      sandboxId?: string;
      callId?: number;
      serviceId?: number;
      token?: string | null;
    }): Promise<
      | { botId: string }
      | {
          error: string;
          code:
            | 'auth_required'
            | 'not_found'
            | 'operator_unreachable'
            | 'stale_state'
            | 'conflict';
        }
    > => {
      if (!operatorApiUrl) {
        const error = {
          error: 'Operator API URL not configured',
          code: 'operator_unreachable' as const,
        };
        setSecretsLookupError(error.error);
        return error;
      }
      const result = await resolveBot(operatorApiUrl, opts);
      if ('botId' in result) {
        if (latestDeployment && latestDeployment.botId !== result.botId) {
          updateProvision(latestDeployment.id, { botId: result.botId });
        }
        setSecretsLookupError(null);
        return result;
      }
      setSecretsLookupError(result.error);
      return result;
    },
    [latestDeployment, operatorApiUrl],
  );

  const handleSubmitSecrets = async () => {
    if (!latestDeployment) return;
    const canResumeInstanceProvision =
      isInstance && latestDeployment.serviceId != null;
    if (
      !canResumeInstanceProvision &&
      !latestDeployment.sandboxId &&
      latestDeployment.callId == null
    )
      return;
    if (!useOperatorKey && !apiKey.trim()) return;
    if (operatorRouteMismatchMessage) {
      setSecretsLookupError(operatorRouteMismatchMessage);
      return;
    }

    setIsSubmittingSecrets(true);
    setActivationPhase(null);
    setSecretsLookupError(null);

    let authToken = operatorAuth.token;
    if (!authToken) {
      authToken = await operatorAuth.authenticate();
      if (!authToken) {
        setSecretsLookupError(
          'Wallet authentication required to load bot data.',
        );
        setIsSubmittingSecrets(false);
        return;
      }
    }

    let targetDeployment = latestDeployment;
    let botId: string;

    if (isInstance && operatorMeta?.deployment_kind === 'instance') {
      let reconciled = await reconcileInstanceDeployment(authToken);
      if (reconciled.kind === 'auth_required') {
        operatorAuth.clearCachedToken();
        authToken = await operatorAuth.authenticate();
        if (!authToken) {
          setSecretsLookupError(
            'Wallet authentication required to load bot data.',
          );
          setIsSubmittingSecrets(false);
          return;
        }
        reconciled = await reconcileInstanceDeployment(authToken);
      }

      if (reconciled.kind === 'missing') {
        setSecretsLookupError(reconciled.message);
        setStep('configure');
        setIsSubmittingSecrets(false);
        return;
      }

      if (reconciled.kind === 'error') {
        setSecretsLookupError(reconciled.message);
        setIsSubmittingSecrets(false);
        return;
      }

      if (reconciled.kind !== 'ok') {
        setSecretsLookupError(
          'Wallet authentication required to load bot data.',
        );
        setIsSubmittingSecrets(false);
        return;
      }

      targetDeployment = reconciled.provision;
      botId = reconciled.provision.botId!;
    } else {
      let botLookup = await resolveBotId({
        botId: latestDeployment.botId,
        sandboxId: latestDeployment.sandboxId,
        callId: latestDeployment.callId,
        serviceId: latestDeployment.serviceId,
        token: authToken,
      });
      if (!('botId' in botLookup) && botLookup.code === 'auth_required') {
        operatorAuth.clearCachedToken();
        authToken = await operatorAuth.authenticate();
        if (!authToken) {
          setSecretsLookupError(
            'Wallet authentication required to load bot data.',
          );
          setIsSubmittingSecrets(false);
          return;
        }
        botLookup = await resolveBotId({
          botId: latestDeployment.botId,
          sandboxId: latestDeployment.sandboxId,
          callId: latestDeployment.callId,
          serviceId: latestDeployment.serviceId,
          token: authToken,
        });
      }
      if (!('botId' in botLookup)) {
        if (botLookup.code === 'stale_state' || botLookup.code === 'conflict') {
          removeProvision(latestDeployment.id);
          setStep('configure');
        }
        setIsSubmittingSecrets(false);
        return;
      }
      botId = botLookup.botId;
    }

    let pollFailures = 0;
    const pollInterval = setInterval(async () => {
      try {
        const progressUrl = operatorMeta
          ? `${operatorApiUrl}${buildBotScopedPath(operatorMeta, botId, '/activation-progress')}`
          : null;
        if (!progressUrl) return;
        const headers: Record<string, string> = {};
        if (operatorAuth.token) {
          headers.Authorization = `Bearer ${operatorAuth.token}`;
        }
        const res = await fetch(progressUrl, { headers });
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
      if (pollFailures >= 10) clearInterval(pollInterval);
    }, 1000);

    try {
      const envJson: Record<string, string> = useOperatorKey
        ? {}
        : buildEnvForProvider(aiProvider, apiKey.trim());
      if (!useOperatorKey) {
        for (const e of extraEnvs) {
          if (e.key.trim() && e.value.trim()) {
            envJson[e.key.trim()] = e.value.trim();
          }
        }
      }

      if (!operatorMeta) {
        throw new Error('Operator metadata not loaded');
      }
      const secretsUrl = `${operatorApiUrl}${buildBotScopedPath(operatorMeta, botId, '/secrets')}`;

      const postSecrets = async (tok: string) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
          return await fetch(secretsUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${tok}`,
            },
            body: JSON.stringify({ env_json: envJson }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      };

      let res = await postSecrets(authToken);

      if (
        res.status === 401 ||
        (!res.ok && (await res.clone().text()).includes('PASETO'))
      ) {
        operatorAuth.clearCachedToken();
        const freshToken = await operatorAuth.authenticate();
        if (!freshToken) throw new Error('Wallet re-authentication failed');
        authToken = freshToken;
        res = await postSecrets(freshToken);
      }

      if (!res.ok) {
        throw await readOperatorError(res);
      }

      const resultJson = (await res.json()) as {
        workflow_id?: string | number | null;
        sandbox_id?: string | null;
      };
      const result = {
        workflow_id: normalizeWorkflowId(resultJson.workflow_id),
        sandbox_id:
          typeof resultJson.sandbox_id === 'string'
            ? resultJson.sandbox_id
            : undefined,
      };

      if (isInstance && userAddress) {
        upsertInstanceProvision({
          ...targetDeployment,
          id: `instance-${targetDeployment.serviceId ?? 0}`,
          owner: userAddress,
          phase: 'active',
          botId,
          workflowId: result.workflow_id,
          sandboxId: result.sandbox_id ?? targetDeployment.sandboxId,
        });
        syncInstanceRouteTarget({
          serviceId: targetDeployment.serviceId,
          botId,
          sandboxId: result.sandbox_id ?? targetDeployment.sandboxId,
        });
      } else {
        updateProvision(targetDeployment.id, {
          phase: 'active',
          botId,
          workflowId: result.workflow_id,
          sandboxId: result.sandbox_id ?? targetDeployment.sandboxId,
        });
      }

      toast.success('API keys configured — agent is now active!');
      dispatchBotsRefresh();
      setApiKey('');
      setExtraEnvs([]);
    } catch (err) {
      if (isStaleStateError(err)) {
        const staleBody = err.body as OperatorErrorBody | null;
        if (isInstance && userAddress) {
          removeMatchingInstanceProvision(userAddress, {
            serviceId:
              targetDeployment.serviceId ?? currentInstanceIdentity.serviceId,
            botId:
              targetDeployment.botId ?? botId ?? currentInstanceIdentity.botId,
            sandboxId:
              staleBody?.sandbox_id ??
              targetDeployment.sandboxId ??
              currentInstanceIdentity.sandboxId,
          });
        } else if (targetDeployment.id) {
          updateProvision(targetDeployment.id, {
            errorMessage: err.message,
            sandboxId: staleBody?.sandbox_id ?? targetDeployment.sandboxId,
          });
        }
        setSecretsLookupError(err.message);
        setStep('configure');
      }
      toast.error(
        `Configuration failed: ${err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'}`,
      );
    } finally {
      clearInterval(pollInterval);
      setIsSubmittingSecrets(false);
      setActivationPhase(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

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
        {step === 'blueprint' &&
          'Choose a blueprint type for your trading agent.'}
        {step === 'configure' &&
          `Configure your ${selectedBlueprint?.name ?? 'trading'} agent, then provision it on-chain.`}
        {step === 'deploy' && 'Your agent is being provisioned on the network.'}
        {step === 'secrets' &&
          'Provide your API keys to activate the trading agent.'}
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
                  if (
                    txHash &&
                    STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf('deploy')
                  )
                    return;
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
        {ambiguousInstanceProvisionMessage && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
            <div>
              <div className="text-sm font-display font-medium text-amber-700 dark:text-amber-400">
                Instance Draft Needs Disambiguation
              </div>
              <div className="mt-0.5 text-xs text-arena-elements-textSecondary">
                {ambiguousInstanceProvisionMessage}
              </div>
            </div>
          </div>
        )}

        {/* Wrong chain banner */}
        {isWrongChain && (
          <div className="flex items-center gap-3 p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <div className="w-3 h-3 rounded-full bg-amber-500 animate-pulse shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-display font-medium text-amber-700 dark:text-amber-400">
                Wrong Network
              </div>
              <div className="text-xs text-arena-elements-textSecondary mt-0.5">
                Your wallet is on chain {walletChainId}. Switch to{' '}
                {targetChain.name} to submit transactions.
              </div>
            </div>
            <Button
              size="sm"
              onClick={() =>
                switchChainAsync({ chainId: targetChain.id }).catch(() =>
                  toast.error(
                    'Failed to switch — add the chain to your wallet manually',
                  ),
                )
              }
            >
              Switch Network
            </Button>
          </div>
        )}

        {/* Step 0: Blueprint Selection */}
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

        {/* Step 1: Configure */}
        {step === 'configure' && (
          <ConfigureStep
            name={name}
            setName={setName}
            strategyType={strategyType}
            setStrategyType={setStrategyType}
            selectedPack={selectedPack}
            isInstance={isInstance}
            serviceId={serviceId}
            serviceInfo={serviceInfo}
            serviceLoading={serviceLoading}
            serviceError={serviceError}
            selectedOperators={selectedOperators}
            setShowAdvanced={setShowAdvanced}
            strategyExecutionNotice={strategyExecutionNotice}
            collateralCapPct={collateralCapPct}
            setCollateralCapPct={setCollateralCapPct}
            canNext={canNext ?? false}
            goNext={goNext}
          />
        )}

        {/* Step 2: Deploy */}
        {step === 'deploy' && (
          <DeployStep
            isInstance={isInstance}
            latestDeployment={latestDeployment}
            txHash={txHash}
            selectedBlueprint={selectedBlueprint}
            selectedPack={selectedPack}
            name={name}
            effectiveCron={effectiveCron}
            serviceId={serviceId}
            serviceInfo={serviceInfo}
            selectedOperators={selectedOperators}
            isConnected={isConnected}
            isPending={isPending}
            isNewServicePending={isNewServicePending}
            newServiceDeploying={newServiceDeploying}
            instanceProvisioning={instanceProvisioning}
            instanceProvisionError={instanceProvisionError}
            isQuoting={isQuoting}
            quotes={quotes}
            totalCost={totalCost}
            handleSubmit={handleSubmit}
            handleDeployNewService={handleDeployNewService}
            setShowInfra={setShowInfra}
            refetchQuotes={refetchQuotes}
            setStep={setStep}
            goBack={goBack}
            resetTx={resetTx}
          />
        )}

        {/* Step 3: Activate */}
        {step === 'secrets' && latestDeployment && (
          <SecretsStep
            latestDeployment={latestDeployment}
            isInstance={isInstance}
            aiProvider={aiProvider}
            setAiProvider={setAiProvider}
            apiKey={apiKey}
            setApiKey={setApiKey}
            extraEnvs={extraEnvs}
            setExtraEnvs={setExtraEnvs}
            envIdRef={envIdRef}
            useOperatorKey={useOperatorKey}
            setUseOperatorKey={setUseOperatorKey}
            isSubmittingSecrets={isSubmittingSecrets}
            activationPhase={activationPhase}
            secretsLookupError={
              operatorRouteMismatchMessage ?? secretsLookupError
            }
            handleSubmitSecrets={handleSubmitSecrets}
            setStep={setStep}
            resetTx={resetTx}
            defaultProvider={defaultProvider}
            validationTrust={validationTrust}
          />
        )}
      </div>

      {/* Dialogs */}
      <InfrastructureDialog
        open={showInfra}
        onOpenChange={setShowInfra}
        isInstance={isInstance}
        serviceMode={serviceMode}
        setServiceMode={setServiceMode}
        discoveredServices={discoveredServices}
        discoveryLoading={discoveryLoading}
        serviceId={serviceId}
        setServiceId={setServiceId}
        serviceInfo={serviceInfo}
        serviceLoading={serviceLoading}
        serviceError={serviceError}
        userAddress={userAddress}
        blueprintId={blueprintId}
        operatorCount={operatorCount}
        discoveredOperators={discoveredOperators}
        selectedOperators={selectedOperators}
        toggleOperator={toggleOperator}
        manualOperator={manualOperator}
        setManualOperator={setManualOperator}
        addManualOperator={addManualOperator}
        isQuoting={isQuoting}
        quotes={quotes}
        quoteErrors={quoteErrors}
        totalCost={totalCost}
        refetchQuotes={refetchQuotes}
        isConnected={isConnected}
        isNewServicePending={isNewServicePending}
        newServiceDeploying={newServiceDeploying}
        handleDeployNewService={handleDeployNewService}
        setNewServiceDeploying={setNewServiceDeploying}
        setNewServiceTxHash={setNewServiceTxHash}
      />

      <AdvancedSettingsDialog
        open={showAdvanced}
        onOpenChange={setShowAdvanced}
        selectedPack={selectedPack}
        fullInstructions={fullInstructions}
        customExpertKnowledge={customExpertKnowledge}
        setCustomExpertKnowledge={setCustomExpertKnowledge}
        customInstructions={customInstructions}
        setCustomInstructions={setCustomInstructions}
        customCron={customCron}
        setCustomCron={setCustomCron}
        customConversationCron={customConversationCron}
        setCustomConversationCron={setCustomConversationCron}
        customResearchCron={customResearchCron}
        setCustomResearchCron={setCustomResearchCron}
        conversationEnabled={conversationEnabled}
        setConversationEnabled={setConversationEnabled}
        researchEnabled={researchEnabled}
        setResearchEnabled={setResearchEnabled}
        validatorMode={validatorMode}
        setValidatorMode={setValidatorMode}
        customValidatorIds={customValidatorIds}
        setCustomValidatorIds={setCustomValidatorIds}
        validationTrust={validationTrust}
        setValidationTrust={setValidationTrust}
        runtimeBackend={runtimeBackend}
        setRuntimeBackend={setRuntimeBackend}
        firecrackerSupported={FIRECRACKER_RUNTIME_SUPPORTED}
        isTeeBlueprint={!!selectedBlueprint?.isTee}
        executionTargets={compatibleExecutionTargets}
        executionTargetId={selectedExecutionTarget?.id ?? executionTargetId}
        setExecutionTargetId={(value) =>
          setExecutionTargetId(value as DexExecutionTargetId)
        }
        selectedExecutionTarget={selectedExecutionTarget}
        executionChainMessage={strategyExecutionNotice}
        liveModeDisabled={
          selectedPack.executionMode === 'paper-only' ||
          selectedPack.executionMode === 'none'
        }
        provisionPaperTrade={provisionPaperTrade}
        setProvisionPaperTrade={setProvisionPaperTrade}
        onOpenInfrastructure={() => {
          setShowAdvanced(false);
          setShowInfra(true);
        }}
      />
    </div>
  );
}
