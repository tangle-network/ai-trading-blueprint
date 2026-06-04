export const TRADING_AGENT_PROFILE_SCHEMA = 'tangle.trading.agent-profile.v1'

export interface TradingAgentProfile {
  schema: typeof TRADING_AGENT_PROFILE_SCHEMA
  profileId: string
  name: string
  objective: {
    primary: 'make_money'
    successMetric: string
    description: string
  }
  mandate: {
    raw: string
    summary: string
    market: string
    preferredVenue: string
  }
  capabilities: {
    focus: string[]
    availableProtocols: string[]
    preferredProtocols: string[]
    protocolChainIds: Record<string, number>
    venueAccessMode: 'all_wired_with_preferences'
  }
  constraints: {
    sizing: string
    drawdown: string
    mode: string
    paper: {
      enabled: true
      initialCapitalUsd: string
    }
  }
  autonomy: {
    selfImprovement: 'enabled'
    researchDelegation: 'allowed'
    reflectionCadence: 'intraday'
    operatingMode: 'agentic_runtime'
  }
  learning: {
    observeOwnTrades: true
    compareSignalsToOutcomes: true
    proposeImprovements: true
    requirePaperEvidenceBeforePromotion: true
  }
  telemetry: {
    traceRuns: true
    traceDelegations: true
    trackTokenUsage: true
    trackCost: true
  }
  activation: {
    paperFirst: true
    executionAdapter: string
    projectedStrategyType: string
  }
  ui: {
    templateLabel?: string
    source: 'create'
  }
  createdAt: string
}

export interface BuildTradingAgentProfileInput {
  name: string
  prompt: string
  market: string
  venue: string
  sizing: string
  drawdown: string
  mode: string
  capabilityFocus: string[]
  availableProtocols: string[]
  preferredProtocols: string[]
  protocolChainIds: Record<string, number>
  projectedStrategyType: string
  templateLabel?: string
  initialCapitalUsd: string
  now?: Date
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function profileSlug(name: string): string {
  const slug = compactWhitespace(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'agent'
}

export function buildTradingAgentProfile(input: BuildTradingAgentProfileInput): TradingAgentProfile {
  const createdAt = (input.now ?? new Date()).toISOString()
  const focus = input.capabilityFocus.filter(Boolean)
  const preferredProtocols = input.preferredProtocols.filter(Boolean)
  const availableProtocols = input.availableProtocols.filter(Boolean)

  return {
    schema: TRADING_AGENT_PROFILE_SCHEMA,
    profileId: `${profileSlug(input.name)}-${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    name: compactWhitespace(input.name),
    objective: {
      primary: 'make_money',
      successMetric: 'risk-adjusted paper P&L before live promotion',
      description: 'Autonomously trade and improve the mandate while preserving explicit owner risk constraints.',
    },
    mandate: {
      raw: input.prompt.trim(),
      summary: `${input.market} through ${input.venue}`,
      market: compactWhitespace(input.market),
      preferredVenue: compactWhitespace(input.venue),
    },
    capabilities: {
      focus,
      availableProtocols,
      preferredProtocols,
      protocolChainIds: input.protocolChainIds,
      venueAccessMode: 'all_wired_with_preferences',
    },
    constraints: {
      sizing: compactWhitespace(input.sizing),
      drawdown: compactWhitespace(input.drawdown),
      mode: compactWhitespace(input.mode),
      paper: {
        enabled: true,
        initialCapitalUsd: input.initialCapitalUsd,
      },
    },
    autonomy: {
      selfImprovement: 'enabled',
      researchDelegation: 'allowed',
      reflectionCadence: 'intraday',
      operatingMode: 'agentic_runtime',
    },
    learning: {
      observeOwnTrades: true,
      compareSignalsToOutcomes: true,
      proposeImprovements: true,
      requirePaperEvidenceBeforePromotion: true,
    },
    telemetry: {
      traceRuns: true,
      traceDelegations: true,
      trackTokenUsage: true,
      trackCost: true,
    },
    activation: {
      paperFirst: true,
      executionAdapter: input.projectedStrategyType,
      projectedStrategyType: input.projectedStrategyType,
    },
    ui: {
      templateLabel: input.templateLabel,
      source: 'create',
    },
    createdAt,
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readStoredTradingAgentProfile(value: unknown): TradingAgentProfile | undefined {
  if (!isRecord(value)) return undefined
  if (value.schema !== TRADING_AGENT_PROFILE_SCHEMA) return undefined
  return value as unknown as TradingAgentProfile
}
