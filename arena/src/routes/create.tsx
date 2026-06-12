import { useState, useCallback, useRef, useEffect, useMemo, type CSSProperties } from 'react'
import type { MetaFunction } from 'react-router'
import { useNavigate } from 'react-router'
import { Button } from '@tangle-network/blueprint-ui/components'
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader'
import { saveCreateStrategyDraft, type CreateStrategyDraft } from '~/lib/createStrategyDraft'
import {
  buildTradingAgentProfile,
  type TradingAgentProfile,
} from '~/lib/agentProfile'
import { useOperatorDirectory } from '~/lib/operator/discovery'
import {
  parseMandatePercent,
  toCreateStrategyEvidence,
  useCreatePreview,
} from '~/lib/createPreview'
import { EvidenceCard } from '~/components/create/EvidenceCard'
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  shouldCollapsePaneSize,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls'

export const meta: MetaFunction = () => [
  { title: 'New Trading Agent - Tangle Trading' },
]

type StrategyType = 'dex' | 'yield' | 'prediction' | 'perp'
type CapabilityId = 'dex' | 'yield' | 'prediction' | 'evm_perp' | 'hyperliquid'
type DraftField = 'name' | 'market' | 'venue' | 'sizing' | 'drawdown' | 'mode'

interface CreateWorkspaceLayout {
  railWidth: number
  railCollapsed: boolean
}

const CREATE_WORKSPACE_LAYOUT_KEY = 'arena:create-workspace-layout'
const DEFAULT_CREATE_WORKSPACE_LAYOUT: CreateWorkspaceLayout = {
  railWidth: 360,
  railCollapsed: false,
}
const DEFAULT_PAPER_INITIAL_CAPITAL_USD = '10000'

const PROTOCOL_CHAIN_IDS = {
  uniswap_v3: 84532,
  aerodrome: 84532,
  aave_v3: 84532,
  morpho_vault: 84532,
  polymarket_clob: 137,
  gmx_v2: 42161,
  vertex: 42161,
  hyperliquid: 998,
} as const

const ALL_WIRED_PROTOCOLS = Object.keys(PROTOCOL_CHAIN_IDS)

const CAPABILITY_PROFILES = [
  {
    id: 'hyperliquid',
    label: 'Hyperliquid Perps',
    icon: 'i-ph:pulse',
    strategyType: 'perp',
    protocols: ['hyperliquid'],
    summary: 'ETH/BTC perps, margin, liquidation buffer',
  },
  {
    id: 'dex',
    label: 'DEX Spot',
    icon: 'i-ph:currency-eth',
    strategyType: 'dex',
    protocols: ['uniswap_v3', 'aerodrome'],
    summary: 'Uniswap and Aerodrome spot routes',
  },
  {
    id: 'yield',
    label: 'DeFi Yield',
    icon: 'i-ph:chart-line-up',
    strategyType: 'yield',
    protocols: ['aave_v3', 'morpho_vault'],
    summary: 'Aave and Morpho lending opportunities',
  },
  {
    id: 'prediction',
    label: 'Prediction Markets',
    icon: 'i-ph:newspaper-clipping',
    strategyType: 'prediction',
    protocols: ['polymarket_clob'],
    summary: 'Polymarket event books and news edge',
  },
  {
    id: 'evm_perp',
    label: 'EVM Perps',
    icon: 'i-ph:chart-line-up',
    strategyType: 'perp',
    protocols: ['gmx_v2', 'vertex'],
    summary: 'GMX and Vertex perp venues',
  },
] satisfies Array<{
  id: CapabilityId
  label: string
  icon: string
  strategyType: StrategyType
  protocols: string[]
  summary: string
}>

const DEFAULT_CAPABILITY_IDS: CapabilityId[] = ['hyperliquid', 'dex', 'yield']

function normalizeCreateWorkspaceLayout(value: Partial<CreateWorkspaceLayout>): CreateWorkspaceLayout {
  return {
    railWidth: clampNumber(
      Number(value.railWidth) || DEFAULT_CREATE_WORKSPACE_LAYOUT.railWidth,
      300,
      480,
    ),
    railCollapsed: value.railCollapsed === true,
  }
}

const STRATEGY_HINTS = [
  {
    label: 'DEX Momentum',
    icon: 'i-ph:currency-eth',
    strategyType: 'dex',
    capabilityIds: ['dex'],
    profile: 'DEX spot',
    shorthand: 'ETH/USDC momentum + mean reversion',
    prompt: 'I want an agent that trades ETH/USDC on Uniswap V3, using momentum and mean-reversion signals with strict risk management.',
  },
  {
    label: 'Hyperliquid Perps',
    icon: 'i-ph:pulse',
    strategyType: 'perp',
    capabilityIds: ['hyperliquid'],
    profile: 'Perps',
    shorthand: 'ETH-PERP breakout + liquidation buffer',
    prompt: 'I want an agent that trades ETH perps on Hyperliquid, using breakout retests with strict max leverage, liquidation buffer, and drawdown limits.',
  },
  {
    label: 'Prediction Markets',
    icon: 'i-ph:newspaper-clipping',
    strategyType: 'prediction',
    capabilityIds: ['prediction'],
    profile: 'Events',
    shorthand: 'Polymarket news edge',
    prompt: 'I want to trade political and news events on Polymarket. Find markets with edge and manage positions.',
  },
  {
    label: 'Yield Router',
    icon: 'i-ph:chart-line-up',
    strategyType: 'yield',
    capabilityIds: ['yield'],
    profile: 'Yield',
    shorthand: 'Aave/Morpho rate rotation',
    prompt: 'Build me an agent that maximizes yield across Aave and Morpho lending protocols, auto-rebalancing between the best rates.',
  },
  {
    label: 'Multi-Venue',
    icon: 'i-ph:strategy',
    strategyType: 'dex',
    capabilityIds: ['hyperliquid', 'dex', 'yield', 'prediction', 'evm_perp'],
    profile: 'Portfolio',
    shorthand: 'Adaptive mandate across wired venues',
    prompt: 'Build a diversified adaptive trading agent. It can use Hyperliquid perps, DEX spot routes, DeFi yield, prediction markets, GMX, and Vertex when the setup is actually attractive. Start in paper mode with strict risk controls.',
  },
] satisfies Array<{
  label: string
  icon: string
  strategyType: StrategyType
  capabilityIds: CapabilityId[]
  profile: string
  shorthand: string
  prompt: string
}>

const DEFAULT_STRATEGY_HINT =
  STRATEGY_HINTS.find((hint) => hint.strategyType === 'perp') ?? STRATEGY_HINTS[0]

const STRATEGY_PROFILES: Record<StrategyType, {
  label: string
  venue: string
  route: string
  envelope: string
  icon: string
}> = {
  dex: {
    label: 'DEX Spot',
    venue: 'Uniswap V3 / Base',
    route: 'Signal replay -> paper start -> workspace',
    envelope: 'Small probes, slippage cap, drawdown guard',
    icon: 'i-ph:currency-eth',
  },
  yield: {
    label: 'Yield Router',
    venue: 'Aave / Morpho',
    route: 'Rate scan -> risk check -> workspace',
    envelope: 'Protocol allowlist, liquidity guard, rebalance cap',
    icon: 'i-ph:chart-line-up',
  },
  prediction: {
    label: 'Prediction Markets',
    venue: 'Polymarket / event books',
    route: 'Scenario search -> tiny paper/live path -> workspace',
    envelope: 'Bounded downside, market depth, no mandate drift',
    icon: 'i-ph:newspaper-clipping',
  },
  perp: {
    label: 'Perps',
    venue: 'Hyperliquid Perps',
    route: 'Fast replay -> margin check -> workspace',
    envelope: 'Leverage cap, liquidation buffer, latency check',
    icon: 'i-ph:pulse',
  },
}

function inferStrategyType(strategyPrompt: string): StrategyType {
  const promptLower = strategyPrompt.toLowerCase()
  if (promptLower.includes('yield') || promptLower.includes('lending') || promptLower.includes('aave')) {
    return 'yield'
  }
  if (promptLower.includes('polymarket') || promptLower.includes('prediction') || promptLower.includes('politics')) {
    return 'prediction'
  }
  if (promptLower.includes('perp') || promptLower.includes('leverage') || promptLower.includes('futures')) {
    return 'perp'
  }
  return 'dex'
}

function capabilityById(id: CapabilityId) {
  return CAPABILITY_PROFILES.find((capability) => capability.id === id) ?? CAPABILITY_PROFILES[0]
}

function capabilityIdsForPrompt(strategyPrompt: string, strategyType: StrategyType): CapabilityId[] {
  const promptLower = strategyPrompt.toLowerCase()
  const ids = new Set<CapabilityId>()
  if (promptLower.includes('hyperliquid') || promptLower.includes('hype')) ids.add('hyperliquid')
  if (promptLower.includes('gmx') || promptLower.includes('vertex')) ids.add('evm_perp')
  if (promptLower.includes('uniswap') || promptLower.includes('aerodrome') || promptLower.includes('dex') || promptLower.includes('spot')) ids.add('dex')
  if (promptLower.includes('yield') || promptLower.includes('lending') || promptLower.includes('aave') || promptLower.includes('morpho')) ids.add('yield')
  if (promptLower.includes('polymarket') || promptLower.includes('prediction') || promptLower.includes('event')) ids.add('prediction')

  if (ids.size === 0) {
    const byType = CAPABILITY_PROFILES.find((capability) => capability.strategyType === strategyType)
    if (byType) ids.add(byType.id)
  }

  return ids.size > 0 ? [...ids] : [...DEFAULT_CAPABILITY_IDS]
}

function normalizeCapabilityIds(ids: CapabilityId[]): CapabilityId[] {
  const seen = new Set<CapabilityId>()
  for (const id of ids) {
    if (CAPABILITY_PROFILES.some((capability) => capability.id === id)) {
      seen.add(id)
    }
  }
  return seen.size > 0 ? [...seen] : [...DEFAULT_CAPABILITY_IDS]
}

function preferredProtocolsForCapabilities(capabilityIds: CapabilityId[]): string[] {
  const protocols = new Set<string>()
  for (const id of normalizeCapabilityIds(capabilityIds)) {
    for (const protocol of capabilityById(id).protocols) {
      protocols.add(protocol)
    }
  }
  return [...protocols]
}

function capabilityLabels(capabilityIds: CapabilityId[]): string[] {
  return normalizeCapabilityIds(capabilityIds).map((id) => capabilityById(id).label)
}

function primaryCapabilityFor(capabilityIds: CapabilityId[], strategyType: StrategyType) {
  const normalized = normalizeCapabilityIds(capabilityIds)
  return (
    normalized
      .map(capabilityById)
      .find((capability) => capability.strategyType === strategyType) ??
    capabilityById(normalized[0])
  )
}

function inferProvisionStrategyType(strategyPrompt: string, strategyType: StrategyType): string {
  const promptLower = strategyPrompt.toLowerCase()
  if (
    strategyType === 'perp' &&
    (promptLower.includes('hyperliquid') || promptLower.includes('hype') || promptLower.includes('hyperevm'))
  ) {
    return 'hyperliquid_perp'
  }
  return strategyType
}

function inferMarket(strategyPrompt: string, strategyType: StrategyType): string {
  const promptUpper = strategyPrompt.toUpperCase()
  const assetMatch = promptUpper.match(/\b(BTC|ETH|SOL|HYPE|BNB|XRP|DOGE|AVAX|LINK)\b/)
  const asset = assetMatch?.[1] ?? (strategyType === 'yield' ? 'USDC' : 'ETH')

  if (strategyType === 'perp') return `${asset}-PERP`
  if (strategyType === 'yield') return `${asset} lending`
  if (strategyType === 'prediction') {
    if (promptUpper.includes('CRYPTO')) return 'Crypto events'
    if (promptUpper.includes('POLITIC')) return 'Political events'
    return 'Event markets'
  }
  return promptUpper.includes('/') ? strategyPrompt.match(/\b[A-Z0-9]{2,8}\/[A-Z0-9]{2,8}\b/i)?.[0]?.toUpperCase() ?? 'ETH/USDC' : `${asset}/USDC`
}

function inferVenue(strategyPrompt: string, strategyType: StrategyType, fallbackVenue: string): string {
  const promptLower = strategyPrompt.toLowerCase()
  if (promptLower.includes('hyperliquid')) return 'Hyperliquid'
  if (promptLower.includes('uniswap')) return 'Uniswap V3 / Base'
  if (promptLower.includes('aerodrome')) return 'Aerodrome / Base'
  if (promptLower.includes('polymarket')) return 'Polymarket'
  if (promptLower.includes('morpho') && promptLower.includes('aave')) return 'Aave / Morpho'
  if (promptLower.includes('morpho')) return 'Morpho'
  if (promptLower.includes('aave')) return 'Aave'
  if (strategyType === 'perp') return 'Hyperliquid'
  return fallbackVenue
}

function inferSizing(strategyPrompt: string, strategyType: StrategyType): string {
  const promptLower = strategyPrompt.toLowerCase()
  const leverageMatch = promptLower.match(/(\d+(?:\.\d+)?)\s*x/)
  if (leverageMatch && strategyType === 'perp') return `${leverageMatch[1]}x max leverage`

  const percentMatch = promptLower.match(/(\d+(?:\.\d+)?)\s*%[^.]{0,32}(?:position|sizing|size|allocation|capital|collateral)/)
  if (percentMatch) return `${percentMatch[1]}% max position`

  if (strategyType === 'perp') return '3x max leverage'
  if (strategyType === 'prediction') return '5% max market exposure'
  if (strategyType === 'yield') return '25% max protocol allocation'
  return '10% max position'
}

function inferDrawdown(strategyPrompt: string, strategyType: StrategyType): string {
  const promptLower = strategyPrompt.toLowerCase()
  const drawdownMatch = promptLower.match(/(\d+(?:\.\d+)?)\s*%[^.]{0,36}(?:drawdown|loss|risk)/)
  if (drawdownMatch) return `${drawdownMatch[1]}% max drawdown`

  if (strategyType === 'perp') return '5% max drawdown'
  if (strategyType === 'prediction') return '3% max daily loss'
  if (strategyType === 'yield') return '2% rebalance loss guard'
  return '4% max drawdown'
}

function draftNameFor(strategyType: StrategyType, market: string): string {
  const marketRoot = market
    .replace(/-PERP/i, '')
    .replace(/\/USDC/i, '')
    .replace(/\s+lending/i, '')
    .trim()

  if (strategyType === 'perp') return `${marketRoot || 'ETH'} Perp Breakout`
  if (strategyType === 'prediction') return 'Polymarket Event Scout'
  if (strategyType === 'yield') return `${marketRoot || 'USDC'} Yield Router`
  return `${marketRoot || 'ETH'} Spot Momentum`
}

function buildStrategyDraft({
  prompt,
  strategyType,
  profile,
  overrides,
}: {
  prompt: string
  strategyType: StrategyType
  profile: typeof STRATEGY_PROFILES[StrategyType]
  overrides: Partial<Record<DraftField, string>>
}): CreateStrategyDraft {
  const market = inferMarket(prompt, strategyType)
  const inferred = {
    name: draftNameFor(strategyType, market),
    market,
    venue: inferVenue(prompt, strategyType, profile.venue),
    sizing: inferSizing(prompt, strategyType),
    drawdown: inferDrawdown(prompt, strategyType),
    mode: 'Paper start',
  }
  const merged = {
    ...inferred,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => typeof value === 'string' && value.trim()),
    ),
  } as Record<DraftField, string>

  return {
    name: merged.name,
    strategyType,
    provisionStrategyType: inferProvisionStrategyType(prompt, strategyType),
    market: merged.market,
    venue: merged.venue,
    sizing: merged.sizing,
    drawdown: merged.drawdown,
    mode: merged.mode,
    prompt,
    updatedAt: Date.now(),
  }
}

function buildCreatePrompt(draft: CreateStrategyDraft, capabilityIds: CapabilityId[]): string {
  const preferredProtocols = preferredProtocolsForCapabilities(capabilityIds)
  return [
    draft.prompt.trim(),
    '',
    'Agent profile:',
    `Agent name: ${draft.name}`,
    'Objective: make money through risk-adjusted self-improvement',
    `Primary capability: ${primaryCapabilityFor(capabilityIds, draft.strategyType as StrategyType).label}`,
    `Capability focus: ${capabilityLabels(capabilityIds).join(', ')}`,
    `Venue access: all wired protocols (${ALL_WIRED_PROTOCOLS.join(', ')})`,
    `Preferred protocols: ${preferredProtocols.join(', ')}`,
    `Market: ${draft.market}`,
    `Venue: ${draft.venue}`,
    `Sizing: ${draft.sizing}`,
    `Risk: ${draft.drawdown}`,
    `Mode: ${draft.mode}`,
  ].filter(Boolean).join('\n')
}

function buildCreateAgentProfile(
  draft: CreateStrategyDraft,
  capabilityIds: CapabilityId[],
  templateLabel?: string,
): TradingAgentProfile {
  const normalizedCapabilityIds = normalizeCapabilityIds(capabilityIds)
  return buildTradingAgentProfile({
    name: draft.name,
    prompt: draft.prompt,
    market: draft.market,
    venue: draft.venue,
    sizing: draft.sizing,
    drawdown: draft.drawdown,
    mode: draft.mode,
    capabilityFocus: capabilityLabels(normalizedCapabilityIds),
    availableProtocols: ALL_WIRED_PROTOCOLS,
    preferredProtocols: preferredProtocolsForCapabilities(normalizedCapabilityIds),
    protocolChainIds: PROTOCOL_CHAIN_IDS,
    projectedStrategyType: draft.provisionStrategyType,
    templateLabel,
    initialCapitalUsd: DEFAULT_PAPER_INITIAL_CAPITAL_USD,
  })
}

function attachCapabilityFields(
  draft: CreateStrategyDraft,
  capabilityIds: CapabilityId[],
  agentProfile: TradingAgentProfile,
): CreateStrategyDraft {
  const normalizedCapabilityIds = normalizeCapabilityIds(capabilityIds)
  return {
    ...draft,
    agentProfile,
    capabilityFocus: capabilityLabels(normalizedCapabilityIds),
    availableProtocols: ALL_WIRED_PROTOCOLS,
    preferredProtocols: preferredProtocolsForCapabilities(normalizedCapabilityIds),
    protocolChainIds: PROTOCOL_CHAIN_IDS,
  }
}

function clampDraftValue(value: string, maxLength = 80): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function formatOperatorLabel(operatorUrl: string | undefined) {
  if (!operatorUrl) return 'No operator'
  if (operatorUrl.startsWith('/')) return operatorUrl
  try {
    return new URL(operatorUrl).host
  } catch {
    return operatorUrl
  }
}

function compactCapabilityLabel(label: string): string {
  if (/hyperliquid/i.test(label)) return 'Hyper'
  if (/prediction/i.test(label)) return 'Events'
  if (/defi/i.test(label)) return 'Yield'
  if (/evm/i.test(label)) return 'EVM Perps'
  return label
}

function capabilityControlLabel(label: string): string {
  if (/hyperliquid/i.test(label)) return 'Hyperliquid'
  if (/prediction/i.test(label)) return 'Prediction'
  if (/defi/i.test(label)) return 'Yield'
  return label
}

export default function CreateAgent() {
  const [prompt, setPrompt] = useState(DEFAULT_STRATEGY_HINT.prompt)
  const [selectedCapabilityIds, setSelectedCapabilityIds] = useState<CapabilityId[]>(DEFAULT_STRATEGY_HINT.capabilityIds)
  const [draftOverrides, setDraftOverrides] = useState<Partial<Record<DraftField, string>>>({})
  const [isCreating, setIsCreating] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const isCreatingRef = useRef(false)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    CREATE_WORKSPACE_LAYOUT_KEY,
    DEFAULT_CREATE_WORKSPACE_LAYOUT,
    normalizeCreateWorkspaceLayout,
  )
  const navigate = useNavigate()
  const detectedStrategyType = useMemo(() => inferStrategyType(prompt), [prompt])
  const primaryCapability = useMemo(
    () => primaryCapabilityFor(selectedCapabilityIds, detectedStrategyType),
    [detectedStrategyType, selectedCapabilityIds],
  )
  const draftStrategyType = primaryCapability.strategyType
  const detectedProfile = STRATEGY_PROFILES[draftStrategyType]
  const launchSteps = useMemo(() => detectedProfile.route.split(' -> '), [detectedProfile.route])
  const { apiUrls: operatorApiUrls } = useOperatorDirectory()
  const operatorLabel = formatOperatorLabel(operatorApiUrls[0])
  const exactHint = STRATEGY_HINTS.find((hint) => prompt.trim() === hint.prompt)
  const selectedHint = exactHint ?? STRATEGY_HINTS.find((hint) => hint.capabilityIds.some((id) => selectedCapabilityIds.includes(id))) ?? STRATEGY_HINTS[0]
  const selectedCapabilityLabels = useMemo(
    () => capabilityLabels(selectedCapabilityIds),
    [selectedCapabilityIds],
  )
  const primaryRuntimeLabel = compactCapabilityLabel(primaryCapability.label)
  const preferredProtocols = useMemo(
    () => preferredProtocolsForCapabilities(selectedCapabilityIds),
    [selectedCapabilityIds],
  )
  const draft = useMemo(() => buildStrategyDraft({
    prompt,
    strategyType: draftStrategyType,
    profile: detectedProfile,
    overrides: draftOverrides,
  }), [detectedProfile, draftOverrides, draftStrategyType, prompt])
  const compilerRows = useMemo(() => [
    {
      icon: 'i-ph:clock-countdown',
      label: 'Signal',
      value: launchSteps[0] ?? 'Signal replay',
    },
    {
      icon: 'i-ph:shield-check',
      label: 'Risk',
      value: `${draft.sizing}, ${draft.drawdown}`,
    },
    {
      icon: 'i-ph:map-trifold',
      label: 'Venue',
      value: `${draft.venue} / ${draft.market}`,
    },
  ], [draft.drawdown, draft.market, draft.sizing, draft.venue, launchSteps])
  const envelopeChecks = useMemo(
    () => [
      draft.sizing,
      draft.drawdown,
      ...detectedProfile.envelope.split(','),
    ].map((item) => item.trim()).filter(Boolean),
    [detectedProfile.envelope, draft.drawdown, draft.sizing],
  )
  const sizingPct = useMemo(() => parseMandatePercent(draft.sizing), [draft.sizing])
  const drawdownPct = useMemo(() => parseMandatePercent(draft.drawdown), [draft.drawdown])
  const preview = useCreatePreview({
    strategyType: draftStrategyType,
    positionSizePct: sizingPct,
    maxDrawdownPct: drawdownPct,
  })
  const readinessRows = useMemo(() => [
    ['Operator', operatorLabel],
    ['Focus', selectedCapabilityLabels.join(', ')],
    ['Mode', draft.mode],
    ['Access', `${ALL_WIRED_PROTOCOLS.length} protocols`],
  ], [draft.mode, operatorLabel, selectedCapabilityLabels])
  const routeStatus = error ? error : status || `${draft.name} / ${draft.venue} / ${draft.drawdown}`
  const setDraftField = useCallback((field: DraftField, value: string) => {
    setDraftOverrides((current) => ({
      ...current,
      [field]: value,
    }))
  }, [])
  const workspaceStyle = {
    '--create-rail-width': `${layout.railWidth}px`,
  } as CSSProperties
  const workspaceGridClass = layout.railCollapsed
    ? 'lg:grid-cols-[minmax(0,1fr)_8px_44px]'
    : 'lg:grid-cols-[minmax(0,1fr)_8px_minmax(300px,var(--create-rail-width))]'
  const startRailResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const rect = workspace.getBoundingClientRect()
    setLayout((current) => ({ ...current, railCollapsed: false }))
    beginWorkspaceResize(event, {
      cursor: 'col-resize',
      onMove: (moveEvent) => {
        const maxWidth = Math.min(480, Math.max(360, rect.width * 0.4))
        const rawWidth = rect.right - moveEvent.clientX
        if (shouldCollapsePaneSize(rawWidth)) {
          setLayout((current) => ({
            ...current,
            railCollapsed: true,
          }))
          return
        }
        const nextWidth = clampNumber(rawWidth, 300, maxWidth)
        setLayout((current) => ({
          ...current,
          railWidth: nextWidth,
          railCollapsed: false,
        }))
      },
    })
  }

  useEffect(() => {
    if (typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches) {
      textareaRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  const handleCreate = useCallback(() => {
    if (!prompt.trim() || isCreatingRef.current) return
    isCreatingRef.current = true
    const cleanDraft: CreateStrategyDraft = {
      ...draft,
      name: clampDraftValue(draft.name, 64) || draftNameFor(draftStrategyType, draft.market),
      market: clampDraftValue(draft.market),
      venue: clampDraftValue(draft.venue),
      sizing: clampDraftValue(draft.sizing),
      drawdown: clampDraftValue(draft.drawdown),
      mode: clampDraftValue(draft.mode, 32) || 'Paper start',
    }
    const createPrompt = buildCreatePrompt(cleanDraft, selectedCapabilityIds)
    const agentProfile = buildCreateAgentProfile(cleanDraft, selectedCapabilityIds, selectedHint.label)
    setIsCreating(true)
    setStatus('Opening wallet review…')
    setError('')
    saveCreateStrategyDraft({
      ...attachCapabilityFields(cleanDraft, selectedCapabilityIds, agentProfile),
      prompt: createPrompt,
      evidence: preview.status === 'ready' ? toCreateStrategyEvidence(preview.response) : undefined,
    })
    navigate('/provision?draft=create')
  }, [draft, draftStrategyType, preview, prompt, navigate, selectedCapabilityIds, selectedHint.label])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreate()
    }
  }, [handleCreate])

  return (
    <div className="arena-trace-terminal flex min-h-full w-full overflow-y-auto bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)] lg:h-full lg:min-h-0 lg:overflow-hidden">
      <section className="flex w-full flex-1 flex-col lg:h-full lg:min-h-0">
        <ArenaPageHeader
          title="New Agent"
          titleWidthClassName="min-[1180px]:w-[11rem]"
          metrics={[
            { label: 'Focus', value: primaryRuntimeLabel, title: selectedCapabilityLabels.join(', ') },
            { label: 'Venues', value: String(ALL_WIRED_PROTOCOLS.length), title: ALL_WIRED_PROTOCOLS.join(', ') },
            { label: 'Mode', value: 'Paper' },
          ]}
          controls={(
            <>
              <WorkspaceControlButton
                label={layout.railCollapsed ? 'Restore profile rail' : 'Minimize profile rail'}
                icon={layout.railCollapsed ? 'i-ph:sidebar-simple' : 'i-ph:minus-bold'}
                onClick={() => setLayout((current) => ({
                  ...current,
                  railCollapsed: !current.railCollapsed,
                }))}
              />
              <WorkspaceControlButton
                label="Reset workspace"
                icon="i-ph:arrow-counter-clockwise"
                onClick={() => setLayout(DEFAULT_CREATE_WORKSPACE_LAYOUT)}
              />
              <ArenaHeaderLink to="/leaderboard" icon="i-ph:table">Agents</ArenaHeaderLink>
            </>
          )}
        />

        <div
          ref={workspaceRef}
          className={`grid gap-0 lg:min-h-0 lg:flex-1 ${workspaceGridClass}`}
          style={workspaceStyle}
        >
          <form
            id="create-agent-form"
            className="grid content-start border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] lg:col-start-1 lg:min-h-0 lg:self-start lg:grid-rows-[auto_auto_auto] lg:overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault()
              handleCreate()
            }}
          >
            <div className="grid shrink-0 gap-3 border-b border-[var(--arena-terminal-border)] px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <label
                htmlFor="agent-mandate-prompt"
                className="font-display text-base font-semibold text-[var(--arena-terminal-text)]"
              >
                Mandate
              </label>
              <div className="inline-flex w-fit items-center gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2.5 py-1.5 font-mono text-xs text-[var(--arena-terminal-text-secondary)]">
                <span className={`${detectedProfile.icon} text-base text-[var(--arena-terminal-accent)]`} aria-hidden="true" />
                <span>{detectedProfile.label}</span>
              </div>
            </div>

            <div className="grid shrink-0 bg-[var(--arena-terminal-bg)]">
              <textarea
                id="agent-mandate-prompt"
                ref={textareaRef}
                value={prompt}
                onChange={(e) => {
                  const nextPrompt = e.target.value
                  setPrompt(nextPrompt)
                  setSelectedCapabilityIds(capabilityIdsForPrompt(nextPrompt, inferStrategyType(nextPrompt)))
                }}
                onKeyDown={handleKeyDown}
                placeholder="Trade ETH-PERP momentum with 3x max leverage, 5% max drawdown, and a liquidation buffer…"
                disabled={isCreating}
                name="agent-mandate-prompt"
                autoComplete="off"
                aria-label="Trading agent mandate prompt"
                aria-describedby="agent-create-status"
                className="h-[150px] resize-none bg-[var(--arena-terminal-bg)] px-4 py-3 font-mono text-[15px] leading-6 text-[var(--arena-terminal-text)] placeholder:text-[var(--arena-terminal-text-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--arena-terminal-accent)] disabled:opacity-50 md:h-[136px] lg:h-[124px] min-[1440px]:h-[136px]"
              />
            </div>

            <div className="grid items-start gap-2 border-t border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-2 xl:grid-cols-[minmax(0,1fr)_320px]">
              <section className="grid overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                      Agent Profile
                    </h2>
                    <p className="truncate font-mono text-[11px] text-[var(--arena-terminal-text-muted)]">
                      {selectedHint.shorthand}
                    </p>
                  </div>
                  <span className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-secondary)]">
                    Paper
                  </span>
                </div>
                <div className="grid grid-cols-1 min-[1440px]:grid-cols-2">
                  <DraftTicketField
                    label="Name"
                    value={draft.name}
                    disabled={isCreating}
                    onChange={(value) => setDraftField('name', value)}
                    maxLength={64}
                  />
                  <DraftTicketField
                    label="Market"
                    value={draft.market}
                    disabled={isCreating}
                    onChange={(value) => setDraftField('market', value)}
                  />
                  <DraftTicketField
                    label="Venue"
                    value={draft.venue}
                    disabled={isCreating}
                    onChange={(value) => setDraftField('venue', value)}
                  />
                  <DraftTicketField
                    label="Sizing"
                    value={draft.sizing}
                    disabled={isCreating}
                    onChange={(value) => setDraftField('sizing', value)}
                  />
                  <DraftTicketField
                    label="Risk"
                    value={draft.drawdown}
                    disabled={isCreating}
                    onChange={(value) => setDraftField('drawdown', value)}
                  />
                  <DraftTicketField
                    label="Mode"
                    value={draft.mode}
                    disabled={isCreating}
                    onChange={(value) => setDraftField('mode', value)}
                  />
                </div>
              </section>

              <section className="grid overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
                <div className="border-b border-[var(--arena-terminal-border)] px-3 py-2">
                  <h2 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                    Capabilities
                  </h2>
                  <p className="truncate font-mono text-[11px] text-[var(--arena-terminal-text-muted)]">
                    Focus does not limit venue access
                  </p>
                </div>
                <div className="grid gap-1.5 border-b border-[var(--arena-terminal-border)] p-2 sm:grid-cols-2 min-[1440px]:grid-cols-3">
                  {CAPABILITY_PROFILES.map((capability) => (
                    <CapabilityToggle
                      key={capability.id}
                      capability={capability}
                      active={selectedCapabilityIds.includes(capability.id)}
                      disabled={isCreating}
                      onToggle={() => {
                        setSelectedCapabilityIds((current) => {
                          const normalized = normalizeCapabilityIds(current)
                          if (normalized.includes(capability.id)) {
                            return normalized.length > 1
                              ? normalized.filter((id) => id !== capability.id)
                              : normalized
                          }
                          return normalizeCapabilityIds([...normalized, capability.id])
                        })
                      }}
                    />
                  ))}
                </div>
                <div className="grid gap-2 border-b border-[var(--arena-terminal-border)] p-2">
                  {envelopeChecks.slice(0, 4).map((check) => (
                    <RiskCheck key={check} label={check} />
                  ))}
                </div>
                <div className="grid gap-2 p-2 lg:min-h-0 lg:overflow-auto lg:[scrollbar-gutter:stable]">
                  {compilerRows.map((row) => (
                    <RouteChip key={row.label} icon={row.icon} label={row.label} value={row.value} />
                  ))}
                  <RouteChip icon="i-ph:plug-charging" label="Access" value={`${ALL_WIRED_PROTOCOLS.length} wired protocols / focus ${preferredProtocols.join(', ')}`} />
                </div>
              </section>
            </div>
          </form>

          <WorkspaceResizeHandle
            orientation="vertical"
            className="hidden lg:col-start-2 lg:row-start-1 lg:flex"
            ariaLabel="Resize profile rail"
            title="Drag to resize profile rail"
            onPointerDown={startRailResize}
          />

          {layout.railCollapsed ? (
            <WorkspaceCollapsedPane
              label="Profile"
              icon="i-ph:strategy"
              orientation="vertical"
              className="hidden lg:col-start-3 lg:row-start-1 lg:flex"
              onClick={() => setLayout((current) => ({ ...current, railCollapsed: false }))}
            />
          ) : (
          <aside className="grid overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] lg:col-start-3 lg:row-start-1 lg:min-h-0 lg:grid-rows-[auto_auto_auto]">
            <section className="grid overflow-hidden border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
              <div className="grid grid-cols-[34px_minmax(0,1fr)] items-center gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2">
                <span className="flex h-[34px] w-[34px] items-center justify-center border border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]">
                  <span className={`${detectedProfile.icon} text-lg`} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="truncate font-display text-base font-semibold text-[var(--arena-terminal-text)]">Mandate Seeds</h2>
                  <p className="truncate font-mono text-xs text-[var(--arena-terminal-text-muted)]">{detectedProfile.label} / {detectedProfile.venue}</p>
                </div>
              </div>
              <div className="grid gap-1 p-2">
                {STRATEGY_HINTS.map((hint) => {
                  const active = selectedHint.label === hint.label

                  return (
                    <StrategyBookButton
                      key={hint.label}
                      hint={hint}
                      active={active}
                      disabled={isCreating}
                      onSelect={() => {
                        setPrompt(hint.prompt)
                        setSelectedCapabilityIds(hint.capabilityIds)
                        setDraftOverrides({})
                        setError('')
                        setStatus('')
                        textareaRef.current?.focus()
                      }}
                    />
                  )
                })}
              </div>
            </section>

            <section className="overflow-hidden border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2">
                <h2 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Execution</h2>
                <span className="font-mono text-xs text-[var(--arena-terminal-text-secondary)]">Paper</span>
              </div>
              <div className="grid grid-cols-2">
                {readinessRows.map(([label, value]) => (
                  <ReadinessRow key={label} label={label} value={value} />
                ))}
              </div>
            </section>

            <section className="grid content-start gap-2 overflow-hidden bg-[var(--arena-terminal-panel)] p-2.5 lg:min-h-0 lg:overflow-auto lg:[scrollbar-gutter:stable]">
              <EvidenceCard state={preview} drawdownLimitPct={drawdownPct} />
              <div
                id="agent-create-status"
                aria-live="polite"
                className="min-h-5 min-w-0 font-mono text-xs text-[var(--arena-terminal-text-muted)]"
              >
                {error ? (
                  <p
                    ref={errorRef}
                    tabIndex={-1}
                    role="alert"
                    className="break-words text-[var(--arena-terminal-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-danger)]"
                  >
                    {routeStatus}
                  </p>
                ) : (
                  <p role="status" className="line-clamp-2">{routeStatus}</p>
                )}
              </div>
              <Button
                type="submit"
                form="create-agent-form"
                disabled={!prompt.trim() || isCreating}
                className="h-10 w-full rounded-none bg-[var(--arena-terminal-accent)] px-5 font-display text-sm font-semibold text-[var(--arena-terminal-accent-text)] transition-[background-color,opacity,transform] duration-150 hover:bg-[color-mix(in_srgb,var(--arena-terminal-accent)_82%,var(--arena-terminal-text))] active:scale-[0.98] disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
              >
                {isCreating ? 'Opening…' : 'Launch Paper Agent'}
              </Button>
            </section>
          </aside>
          )}
        </div>
      </section>
    </div>
  )
}

function StrategyBookButton({
  hint,
  active,
  disabled,
  onSelect,
}: {
  hint: typeof STRATEGY_HINTS[number]
  active: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={active}
      className={`grid min-h-[42px] w-full grid-cols-[24px_minmax(0,1fr)] items-center gap-2 border px-2 py-1.5 text-left transition-[background-color,border-color,opacity,transform] duration-150 active:scale-[0.99] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] ${
        active
          ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] shadow-[inset_3px_0_0_var(--arena-terminal-accent)]'
          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)]'
      }`}
    >
      <span className="flex h-6 w-6 items-center justify-center bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-accent)]">
        <span className={`${hint.icon} text-base`} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-[13px] font-semibold text-[var(--arena-terminal-text)]">{hint.label}</span>
        <span className="block truncate font-mono text-[10px] text-[var(--arena-terminal-text-muted)]">{hint.shorthand}</span>
      </span>
    </button>
  )
}

function DraftTicketField({
  label,
  value,
  disabled,
  onChange,
  maxLength = 80,
}: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
  maxLength?: number
}) {
  return (
    <label className="grid min-w-0 gap-1 border-b border-[var(--arena-terminal-border)] px-3 py-2 last:border-b-0 min-[1440px]:border-r min-[1440px]:even:border-r-0">
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        maxLength={maxLength}
        className="h-7 min-w-0 border border-transparent bg-transparent px-0 font-mono text-[13px] font-semibold text-[var(--arena-terminal-text)] outline-none transition-[background-color,border-color,padding] duration-150 placeholder:text-[var(--arena-terminal-text-subtle)] hover:border-[var(--arena-terminal-border)] hover:bg-[var(--arena-terminal-bg)] hover:px-2 focus:border-[var(--arena-terminal-border-hover)] focus:bg-[var(--arena-terminal-bg)] focus:px-2 focus:ring-2 focus:ring-[var(--arena-terminal-accent-soft)] disabled:opacity-60"
      />
    </label>
  )
}

function RiskCheck({ label }: { label: string }) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] items-center gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2 py-1.5">
      <span className="flex h-[22px] w-[22px] items-center justify-center bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]">
        <span className="i-ph:check-bold text-xs" aria-hidden="true" />
      </span>
      <span className="min-w-0 truncate font-mono text-[12px] text-[var(--arena-terminal-text-secondary)]">
        {label}
      </span>
    </div>
  )
}

function CapabilityToggle({
  capability,
  active,
  disabled,
  onToggle,
}: {
  capability: typeof CAPABILITY_PROFILES[number]
  active: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={active}
      title={capability.summary}
      className={`grid min-h-[50px] grid-cols-[24px_minmax(0,1fr)] items-center gap-2 border px-2 py-1.5 text-left transition-[background-color,border-color,box-shadow,opacity,transform] duration-150 active:scale-[0.99] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] ${
        active
          ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] shadow-[inset_3px_0_0_var(--arena-terminal-accent)]'
          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)]'
      }`}
    >
      <span className="flex h-6 w-6 items-center justify-center bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-accent)]">
        <span className={`${capability.icon} text-sm`} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-[12px] font-semibold text-[var(--arena-terminal-text)]">
          {capabilityControlLabel(capability.label)}
        </span>
        <span className="block truncate font-mono text-[10px] text-[var(--arena-terminal-text-muted)]">
          {capability.protocols.join(', ')}
        </span>
      </span>
    </button>
  )
}

function RouteChip({
  icon,
  label,
  value,
}: {
  icon: string
  label: string
  value: string
}) {
  return (
    <div className="grid min-h-[50px] content-between gap-1.5 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-2.5">
      <span className="flex items-center justify-between gap-3">
        <span className={`${icon} text-base text-[var(--arena-terminal-accent)]`} aria-hidden="true" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">{label}</span>
      </span>
      <span className="line-clamp-2 font-mono text-[11px] leading-4 text-[var(--arena-terminal-text-secondary)]">{value}</span>
    </div>
  )
}

function ReadinessRow({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 border-t border-[var(--arena-terminal-border)] px-3 py-2 odd:border-r">
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">{label}</span>
      <span className="mt-0.5 block min-w-0 truncate font-mono text-xs text-[var(--arena-terminal-text-secondary)]">{value}</span>
    </div>
  )
}
