export type EvalSplit = 'search' | 'dev' | 'holdout'

export interface ScoreBreakdown {
  risk: number
  execution: number
  economics: number
  adaptation: number
  reasoning_placeholder: number
  ops: number
}

export interface AgentEvalFinding {
  severity: string
  subject: string
  message: string
}

export interface PersonaEvalResult {
  scenario_id: string
  persona_id: string
  split: string
  passed: boolean
  score: number
  score_breakdown: ScoreBreakdown
  promotion_recommended: boolean
  deterministic_gates: string[]
  findings: AgentEvalFinding[]
  train_candidate_return_pct: number
  test_candidate_return_pct: number
  train_candidate_sharpe: number
  test_candidate_sharpe: number
  train_candidate_drawdown_pct: number
  test_candidate_drawdown_pct: number
  test_trade_count: number
  sharpe_ratio_decay: number
}

export interface PersonaEvalSuiteReport {
  suite: string
  generated_at: number
  schema_version: number
  passed: number
  failed: number
  total: number
  success_rate: number
  min_score: number
  results: PersonaEvalResult[]
}

export function normalizeSplit(split: string): EvalSplit {
  return split === 'holdout' || split === 'search' || split === 'dev' ? split : 'dev'
}

export function numericRaw(result: PersonaEvalResult): Record<string, number> {
  return {
    passed: result.passed ? 1 : 0,
    score: result.score / 100,
    promotion_recommended: result.promotion_recommended ? 1 : 0,
    train_candidate_return_pct: result.train_candidate_return_pct,
    test_candidate_return_pct: result.test_candidate_return_pct,
    train_candidate_sharpe: result.train_candidate_sharpe,
    test_candidate_sharpe: result.test_candidate_sharpe,
    train_candidate_drawdown_pct: result.train_candidate_drawdown_pct,
    test_candidate_drawdown_pct: result.test_candidate_drawdown_pct,
    test_trade_count: result.test_trade_count,
    sharpe_ratio_decay: result.sharpe_ratio_decay,
  }
}
