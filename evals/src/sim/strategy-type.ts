/**
 * Strategy-type inference for bot provisioning.
 *
 * The operator product API's `POST /api/bots` accepts a `strategy_type`
 * (yield | prediction | perp | dex) that determines which tool surface
 * the provisioned bot's agent gets. Picking the wrong type means the
 * agent has the wrong tools — a Polymarket research question handed to
 * a `dex` (swap-routing) bot can't actually research prediction markets.
 *
 * `local-stack-runner.ts::createBotThroughProductApi` uses keyword
 * matching on the freeform prompt. This module is the strict, typed
 * inference path for research questions (which carry `expected_source_classes`)
 * and robustness scenarios (which carry `venues`). The two heuristics
 * agree on common cases but the typed path catches what the keyword path
 * would miss (e.g., a question whose prompt doesn't contain 'polymarket'
 * but whose expected_source_classes includes 'prediction_markets').
 */

import type { SourceClass } from '../research/thesis-questions.js'

/** Valid strategy_type values the product's pack registry resolves
 *  (trading-blueprint-lib/src/prompts/packs.rs::pack_for). Provisioning a
 *  bot with the wrong type hands it the wrong venue playbook — e.g. a
 *  hyperliquid intent provisioned as 'perp' loads the GMX/Vertex pack whose
 *  methodology (packs.rs:704) EXPLICITLY forbids Hyperliquid native endpoints,
 *  so the bot correctly-but-uselessly refuses. */
export type StrategyType =
  | 'yield'
  | 'prediction'
  | 'perp' // GMX-v2 / Vertex on Arbitrum
  | 'hyperliquid_perp' // Hyperliquid native perps
  | 'dex'
  | 'mm'
  | 'volatility'
  | 'multi'

/** Map an asset-class set (from a research question's expected sources) to
 *  the strategy_type that provisions a bot with matching tools. */
export function inferStrategyTypeFromSourceClasses(classes: SourceClass[]): StrategyType {
  if (classes.includes('prediction_markets')) return 'prediction'
  // Token-unlocks, on-chain metrics, protocol docs all map to dex/perp
  // since they're crypto-asset-centric. No 'analyst' type exists yet;
  // dex is the most general crypto-asset bot.
  return 'dex'
}

/** Map a venue allowlist (from a robustness scenario or user intent) to
 *  the strategy_type that provisions a bot with the right venue tools. */
export function inferStrategyTypeFromVenues(venues: string[]): StrategyType {
  const set = new Set(venues.map((v) => v.toLowerCase()))
  if (set.has('aave_v3') || set.has('aave')) return 'yield'
  if (set.has('polymarket_clob') || set.has('polymarket')) return 'prediction'
  // Hyperliquid gets its OWN pack (hyperliquid_perp) — NOT 'perp'. The 'perp'
  // pack is GMX-v2/Vertex/Arbitrum and its methodology forbids Hyperliquid
  // native execution. Mapping hyperliquid → 'perp' is the bug that scored the
  // entire real-arm 0.03 in smoke v5 (bot faithfully refused per its GMX
  // playbook). This is the single highest-leverage fix in the generation.
  if (set.has('hyperliquid')) return 'hyperliquid_perp'
  if (
    set.has('drift') ||
    set.has('drift_perp') ||
    set.has('gmx_v2') ||
    set.has('vertex')
  ) {
    return 'perp'
  }
  return 'dex'
}
