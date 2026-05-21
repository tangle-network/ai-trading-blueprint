export type LifecycleUserIntent =
  | 'initial_market_maker'
  | 'risk_adjustment'
  | 'find_new_pairs'
  | 'microstructure_review'

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
