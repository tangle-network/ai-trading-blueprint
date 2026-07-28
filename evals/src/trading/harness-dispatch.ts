/**
 * Cell-level dispatch for HarnessConfig backtests — shells out to the Rust
 * CLI `trading-runtime/examples/harness_backtest`. Used by both the
 * developer self-improvement loop and the per-bot runtime loop, so the
 * Rust BacktestEngine is the single source of truth for fitness — no
 * second backtest implementation drifts.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'

import { repoRoot, resolveRepo } from '../lib/repo.js'
import type { BacktestArtifact, BotContext, HarnessConfig } from './harness-types.js'

// Workspace-root target dir: trading-runtime is a workspace member, so
// `cargo build -p trading-runtime --example …` lands in <repo>/target, the
// same place walk-forward.ts resolves its CLI from. (The earlier
// 'trading-runtime/target/…' path was never produced by the workspace build —
// ensureHarnessBacktestBinary rebuilt every call and then spawned a
// nonexistent path.)
const BINARY_REL = 'target/release/examples/harness_backtest'
let preparedBinaryPath: string | undefined

/**
 * Build the Rust cell-level CLI once per process. Cargo's incremental check is
 * cheap when it is current and prevents an old binary from silently ignoring a
 * request field added by newer source.
 */
export function ensureHarnessBacktestBinary(): string {
  if (preparedBinaryPath) return preparedBinaryPath
  const abs = resolveRepo(BINARY_REL)
  const proc = spawnSync(
    'cargo',
    ['build', '-p', 'trading-runtime', '--example', 'harness_backtest', '--release'],
    { cwd: repoRoot, stdio: 'inherit' },
  )
  if (proc.status !== 0) {
    throw new Error(`harness_backtest build failed (status ${proc.status})`)
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`harness_backtest build succeeded but did not produce ${abs}`)
  }
  preparedBinaryPath = abs
  return preparedBinaryPath
}

/** Immutable identity of the exact executable used by every backtest cell. */
export function harnessBacktestExecutionIdentity(binaryPath: string): string {
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    throw new Error(`harness_backtest executable does not exist: ${binaryPath}`)
  }
  const digest = createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('harness_backtest executable did not produce a SHA-256 identity')
  }
  return `trading-runtime/harness-backtest@sha256:${digest}`
}

export interface CandleTimeWindow {
  /** Inclusive Unix timestamp in seconds. */
  startTimeSec: number
  /** Exclusive Unix timestamp in seconds. */
  endTimeSec: number
}

export function validateCandleTimeWindow(window: CandleTimeWindow): CandleTimeWindow {
  if (
    !Number.isSafeInteger(window.startTimeSec) ||
    !Number.isSafeInteger(window.endTimeSec) ||
    window.startTimeSec < 0 ||
    window.endTimeSec <= window.startTimeSec
  ) {
    throw new Error(
      `invalid candle window [${window.startTimeSec}, ${window.endTimeSec}); expected non-negative Unix seconds with start < end`,
    )
  }
  return window
}

export interface DispatchOptions {
  candlesLimit: number
  cacheDir: string
  /** Explicit half-open candle range. Omit only for latest-history evaluations. */
  candleWindow?: CandleTimeWindow
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
  const candleWindow = opts.candleWindow
    ? validateCandleTimeWindow(opts.candleWindow)
    : undefined
  const request = {
    harness,
    source: bot.source,
    symbol: bot.symbol,
    fee_protocol: bot.fee_protocol,
    candles_limit: opts.candlesLimit,
    candles_cache_dir: opts.cacheDir,
    ...(candleWindow
      ? {
          candles_start_time_secs: candleWindow.startTimeSec,
          candles_end_time_secs: candleWindow.endTimeSec,
        }
      : {}),
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
