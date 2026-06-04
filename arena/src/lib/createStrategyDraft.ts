import {
  readStoredTradingAgentProfile,
  type TradingAgentProfile,
} from './agentProfile'

export interface CreateStrategyDraft {
  name: string
  strategyType: string
  provisionStrategyType: string
  agentProfile?: TradingAgentProfile
  capabilityFocus?: string[]
  availableProtocols?: string[]
  preferredProtocols?: string[]
  protocolChainIds?: Record<string, number>
  market: string
  venue: string
  sizing: string
  drawdown: string
  mode: string
  prompt: string
  updatedAt: number
}

export const CREATE_STRATEGY_DRAFT_STORAGE_KEY = 'arena:create-strategy-draft:v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function safeLoadStoredCreateStrategyDraft(): CreateStrategyDraft | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage?.getItem(CREATE_STRATEGY_DRAFT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return null

    const draft: CreateStrategyDraft = {
      name: readString(parsed.name),
      strategyType: readString(parsed.strategyType),
      provisionStrategyType: readString(parsed.provisionStrategyType),
      agentProfile: readStoredTradingAgentProfile(parsed.agentProfile),
      capabilityFocus: Array.isArray(parsed.capabilityFocus)
        ? parsed.capabilityFocus.map(readString).filter(Boolean)
        : undefined,
      availableProtocols: Array.isArray(parsed.availableProtocols)
        ? parsed.availableProtocols.map(readString).filter(Boolean)
        : undefined,
      preferredProtocols: Array.isArray(parsed.preferredProtocols)
        ? parsed.preferredProtocols.map(readString).filter(Boolean)
        : undefined,
      protocolChainIds: isRecord(parsed.protocolChainIds)
        ? Object.fromEntries(
            Object.entries(parsed.protocolChainIds)
              .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
          )
        : undefined,
      market: readString(parsed.market),
      venue: readString(parsed.venue),
      sizing: readString(parsed.sizing),
      drawdown: readString(parsed.drawdown),
      mode: readString(parsed.mode),
      prompt: readString(parsed.prompt),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }

    if (!draft.name || !draft.provisionStrategyType || !draft.prompt) return null
    return draft
  } catch {
    return null
  }
}

export function saveCreateStrategyDraft(draft: CreateStrategyDraft): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage?.setItem(
      CREATE_STRATEGY_DRAFT_STORAGE_KEY,
      JSON.stringify({
        ...draft,
        updatedAt: Date.now(),
      }),
    )
  } catch {
    // Local storage is only a handoff cache. Provision still works without it.
  }
}
