/**
 * Cell-level dispatch for HarnessConfig backtests — shells out to the Rust
 * CLI `trading-runtime/examples/harness_backtest`. Used by both the
 * developer self-improvement loop and the per-bot runtime loop, so the
 * Rust BacktestEngine is the single source of truth for fitness — no
 * second backtest implementation drifts.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { repoRoot, resolveRepo } from '../lib/repo.js'
import type { BacktestArtifact, BotContext, HarnessConfig } from './harness-types.js'

const BINARY_REL = 'trading-runtime/target/release/examples/harness_backtest'

/** Build the Rust cell-level CLI if it isn't already on disk. */
export function ensureHarnessBacktestBinary(): string {
  const abs = resolveRepo(BINARY_REL)
  if (existsSync(abs)) return abs
  const proc = spawnSync(
    'cargo',
    ['build', '-p', 'trading-runtime', '--example', 'harness_backtest', '--release'],
    { cwd: repoRoot, stdio: 'inherit' },
  )
  if (proc.status !== 0) {
    throw new Error(`harness_backtest build failed (status ${proc.status})`)
  }
  return abs
}

export interface DispatchOptions {
  candlesLimit: number
  cacheDir: string
  /** Optional seed for the cell's bootstrap CI — deterministic if set. */
  seed?: number
}

/**
 * Run ONE (harness, bot) cell. Throws on Rust CLI error so the caller's
 * loop sees the failure (the substrate retries / records it as a failed
 * cell — never silent).
 */
export function dispatchHarnessBacktest(
  harness: HarnessConfig,
  bot: BotContext,
  opts: DispatchOptions,
): BacktestArtifact {
  const bin = ensureHarnessBacktestBinary()
  const request = {
    harness,
    source: bot.source,
    symbol: bot.symbol,
    fee_protocol: bot.fee_protocol,
    candles_limit: opts.candlesLimit,
    candles_cache_dir: opts.cacheDir,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  }
  const proc = spawnSync(bin, [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const lastLine = (proc.stdout ?? '').trim().split('\n').pop() ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch (e) {
    throw new Error(
      `harness_backtest output parse failed for ${bot.id}: ${(e as Error).message}; stderr=${proc.stderr}`,
    )
  }
  if (typeof parsed === 'object' && parsed && 'error' in parsed) {
    throw new Error(`harness_backtest error for ${bot.id}: ${(parsed as { error: string }).error}`)
  }
  return parsed as BacktestArtifact
}
