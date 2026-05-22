export type LifecycleUserIntent =
  | 'initial_market_maker'
  | 'risk_adjustment'
  | 'find_new_pairs'
  | 'microstructure_review'
  | 'unsupported_market_request'
  | 'unsafe_live_pressure'
  | 'conflicting_instruction'
  | 'rollback_request'
  | 'paper_shadow_request'
  | 'profitability_claim_check'

export interface SimulatedUserTurn {
  day: number
  intent: LifecycleUserIntent
  message: string
  expectedAgentBehavior: string[]
}

export interface TradingLifecyclePersona {
  id: string
  role: string
  goal: string
  strategyFocus: string[]
  maxTurns: number
  riskProfile: 'risk_off' | 'balanced' | 'aggressive'
  turns: SimulatedUserTurn[]
}

export interface StrategyRevision {
  id: string
  turn: number
  userIntent: LifecycleUserIntent
  description: string
  artifactType: 'harness_config' | 'code_change' | 'research_plan' | 'no_change'
  riskPosture: 'risk_off' | 'balanced' | 'aggressive'
  testsRun: string[]
  backtestScenarioIds: string[]
  agentTask?: {
    taskId: string
    status: string
    patchSha256?: string
    filesChanged: string[]
    roundsUsed: number
    testPassed: number
  }
  realInfra?: {
    tradingApiUrl: string
    snapshotId?: string
    sandboxRevisionId?: string
    selfImprovementRunId?: string
    promotionApproved?: boolean
    blockers: string[]
    candlesUsed?: number
    arenaActiveRevisionId?: string
    arenaRevisionCount?: number
    arenaRevisionParentId?: string
    arenaRevisionStatus?: string
    arenaRevisionRunId?: string
    arenaRevisionCanExecuteLive?: boolean
    parentRevisionId?: string
  }
}

export interface LifecycleValidation {
  pass: boolean
  score: number
  labels: LifecycleLabel[]
  metrics: Record<string, number>
}

export interface LifecycleLabel {
  source: 'user' | 'judge' | 'environment' | 'metric' | 'policy' | 'system'
  kind: string
  value: string | number | boolean
  reason: string
  severity: 'info' | 'warning' | 'error'
}

export interface TradingLifecycleRun {
  scenarioId: string
  persona: TradingLifecyclePersona
  revisions: StrategyRevision[]
  validation: LifecycleValidation
}
