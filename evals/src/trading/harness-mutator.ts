/**
 * Deterministic mutator over the `HarnessConfig` genome — the single
 * source of truth for both the developer self-improvement loop and the
 * per-bot runtime loop. Same kinds the Rust impl carried before PR #116
 * deleted that duplication; now lifted into the correct layer (the
 * agent-eval `Mutator` surface that `evolutionaryDriver` consumes).
 *
 * Every mutation is local-step (one signal threshold, one EMA period,
 * one stop %, …) — large jumps are rare so the search behaves more
 * like local-then-global than wholly random. Invariants of
 * `HarnessConfig::validate` (Rust) are preserved by construction: every
 * mutant has ≥1 entry rule, ≥1 exit rule, `entry_threshold ∈ [0.05,
 * 0.95]`, `max_positions ∈ [1, 10]`.
 */

import type { Mutator } from '@tangle-network/agent-eval/campaign'
import {
  BASELINE_HARNESS,
  type EntryCondition,
  type EntryRule,
  type ExitRule,
  type HarnessConfig,
} from './harness-types.js'

const MUTATION_KINDS = [
  'rsi_period',
  'rsi_threshold',
  'ema_periods',
  'stop_loss',
  'take_profit',
  'entry_threshold',
  'rule_weight',
  'position_size',
  'add_rule',
  'drop_rule',
  'flip_condition',
  'max_positions',
] as const

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function jitter(rng: () => number, range: number): number {
  return (rng() * 2 - 1) * range
}

/** Tiny mulberry32 PRNG — deterministic given seed, no extra deps. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Apply exactly one mutation kind to `parent`. Pure function modulo `seed`.
 * Returns a new HarnessConfig — never mutates the input.
 */
export function mutateHarness(parent: HarnessConfig, seed: number): HarnessConfig {
  const child: HarnessConfig = JSON.parse(JSON.stringify(parent))
  child.version = (parent.version ?? 1) + 1
  const rng = makeRng(seed)
  const kind = MUTATION_KINDS[Math.floor(rng() * MUTATION_KINDS.length)]

  switch (kind) {
    case 'rsi_period': {
      for (const rule of child.entry_rules) {
        if (rule.signal.type === 'rsi') {
          rule.signal.period = clamp(rule.signal.period + Math.round(jitter(rng, 4)), 5, 50)
          break
        }
      }
      break
    }
    case 'rsi_threshold': {
      for (const rule of child.entry_rules) {
        if (rule.signal.type === 'rsi') {
          if (rule.condition.type === 'below') {
            rule.condition.threshold = clamp(rule.condition.threshold + jitter(rng, 8), 5, 45)
          } else if (rule.condition.type === 'above') {
            rule.condition.threshold = clamp(rule.condition.threshold + jitter(rng, 8), 55, 95)
          }
          break
        }
      }
      break
    }
    case 'ema_periods': {
      for (const rule of child.entry_rules) {
        if (rule.signal.type === 'ema_cross') {
          const ns = clamp(rule.signal.short_period + Math.round(jitter(rng, 3)), 3, 50)
          const nl = clamp(rule.signal.long_period + Math.round(jitter(rng, 5)), 10, 200)
          if (ns < nl) {
            rule.signal.short_period = ns
            rule.signal.long_period = nl
          }
          break
        }
      }
      break
    }
    case 'stop_loss': {
      for (const exit of child.exit_rules) {
        if (exit.type === 'stop_loss') {
          exit.pct = clamp(exit.pct + jitter(rng, 2), 1, 15)
          break
        }
      }
      break
    }
    case 'take_profit': {
      for (const exit of child.exit_rules) {
        if (exit.type === 'take_profit') {
          exit.pct = clamp(exit.pct + jitter(rng, 4), 2, 30)
          break
        }
      }
      break
    }
    case 'entry_threshold':
      child.entry_threshold = clamp(child.entry_threshold + jitter(rng, 0.2), 0.05, 0.95)
      break
    case 'rule_weight': {
      if (child.entry_rules.length > 0) {
        const idx = Math.floor(rng() * child.entry_rules.length)
        const rule = child.entry_rules[idx]
        if (rule) rule.weight = clamp(rule.weight + jitter(rng, 0.3), 0.05, 1.0)
      }
      break
    }
    case 'position_size': {
      if (child.position_sizing.method === 'fixed_fraction') {
        child.position_sizing.fraction = clamp(child.position_sizing.fraction + jitter(rng, 0.04), 0.02, 0.4)
      }
      break
    }
    case 'add_rule': {
      if (child.entry_rules.length < 5) {
        const newRule: EntryRule = {
          signal: { type: 'rsi', period: 14 },
          condition: { type: 'below', threshold: 20 + Math.floor(rng() * 20) },
          weight: 0.2 + rng() * 0.6,
          tokens: [],
        }
        child.entry_rules.push(newRule)
      }
      break
    }
    case 'drop_rule': {
      if (child.entry_rules.length > 1) {
        const idx = Math.floor(rng() * child.entry_rules.length)
        child.entry_rules.splice(idx, 1)
      }
      break
    }
    case 'flip_condition': {
      for (const rule of child.entry_rules) {
        const c: EntryCondition = rule.condition
        if (c.type === 'cross_above') { rule.condition = { type: 'cross_below' }; break }
        if (c.type === 'cross_below') { rule.condition = { type: 'cross_above' }; break }
        if (c.type === 'below') { rule.condition = { type: 'above', threshold: 100 - c.threshold }; break }
        if (c.type === 'above') { rule.condition = { type: 'below', threshold: 100 - c.threshold }; break }
      }
      break
    }
    case 'max_positions':
      child.max_positions = clamp(child.max_positions + Math.round(jitter(rng, 2)), 1, 10)
      break
  }

  // Invariant repair — guarantees the mutant always satisfies the Rust validator.
  if (child.entry_rules.length === 0) child.entry_rules.push(BASELINE_HARNESS.entry_rules[0]!)
  if (child.exit_rules.length === 0) (child.exit_rules as ExitRule[]).push({ type: 'stop_loss', pct: 5 })
  return child
}

/**
 * The agent-eval `Mutator` over the `HarnessConfig` surface. Surface is
 * serialised as JSON so it round-trips cleanly through the substrate +
 * the Rust cell-level CLI.
 *
 * Same `Mutator` shape `gtm-agent` and `creative-agent` use for their
 * prompt-addendum surfaces — pluggable into `evolutionaryDriver({mutator})`
 * for either the developer or per-bot loops.
 */
export function harnessMutator(opts: { baseline?: HarnessConfig; seedSalt?: number } = {}): Mutator {
  const baseline = opts.baseline ?? BASELINE_HARNESS
  const salt = opts.seedSalt ?? 0
  let counter = 0
  return {
    kind: 'harness-config',
    async mutate({ currentSurface, populationSize }) {
      const parent: HarnessConfig =
        typeof currentSurface === 'string' && currentSurface.trim().length > 0
          ? (JSON.parse(currentSurface) as HarnessConfig)
          : baseline
      return Array.from({ length: populationSize }, (_, i) => {
        counter += 1
        const seed = ((Date.now() ^ ((i + counter) * 0x9e3779b1)) ^ salt) >>> 0
        return JSON.stringify(mutateHarness(parent, seed))
      })
    },
  }
}
