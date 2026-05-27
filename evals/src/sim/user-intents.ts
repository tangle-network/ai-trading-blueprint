/**
 * Standard user-intent catalog for the multishot eval.
 *
 * Each intent is what a real user would type into the product's chat
 * input. The catalog spans the venues + asset classes the SPEC.md §6
 * tier roadmap names: Hyperliquid perp, Drift perp (Solana),
 * Aerodrome AMM (Base), Aave lending (Base), Polymarket binary,
 * Uniswap V3 LP (Ethereum), CEX spot (Binance/Coinbase mock).
 *
 * Crossed with `STANDARD_USER_PERSONAS` (5 voices), this gives 40
 * persona×intent cells. With reps=3 + 3 bot-kind arms (real/null/stall)
 * = 360 cells per full eval run.
 */

import type { UserIntent } from './user-sim-driver.js'

export const STANDARD_USER_INTENTS: UserIntent[] = [
  // ── Hyperliquid perp ─────────────────────────────────────────────────
  {
    id: 'hl-btc-momentum',
    text: 'Trade BTC perp on Hyperliquid. $10k capital. Momentum-driven entries only. Max 5% drawdown — pull back if you breach.',
    capital_usd: 10_000,
    dd_cap_pct: 5,
    venues: ['hyperliquid'],
  },
  {
    id: 'hl-eth-news-driven',
    text: 'ETH perp on Hyperliquid. $5k. Trade only on clear news catalysts — earnings-style events, ETF flows, hard-fork timing. Be selective.',
    capital_usd: 5_000,
    dd_cap_pct: 8,
    venues: ['hyperliquid'],
  },
  {
    id: 'hl-hype-tight-dd',
    text: 'Trade HYPE perp on Hyperliquid. $10k. Momentum entries. Max 5% DD — pull back if breached. Watch funding-rate flips.',
    capital_usd: 10_000,
    dd_cap_pct: 5,
    venues: ['hyperliquid'],
  },
  {
    id: 'hl-perp-mm',
    text: 'Market-make HYPE perp on Hyperliquid. $25k. Tight quotes both sides. Manage inventory; hedge if it skews >10%.',
    capital_usd: 25_000,
    dd_cap_pct: 8,
    venues: ['hyperliquid'],
  },

  // ── Drift perp (Solana) ──────────────────────────────────────────────
  {
    id: 'drift-sol-momentum',
    text: 'Trade SOL perp on Drift. $5k. Momentum-driven. Respect 6% DD cap. Avoid trading during Solana network congestion.',
    capital_usd: 5_000,
    dd_cap_pct: 6,
    venues: ['drift'],
  },

  // ── Polymarket binary CLOB ───────────────────────────────────────────
  {
    id: 'polymarket-mm-binary',
    text: 'Market-make on Polymarket binary markets — pick high-volume political markets with mid-range odds (0.3-0.7). $2k. Tight quotes, watch for new information.',
    capital_usd: 2_000,
    dd_cap_pct: 10,
    venues: ['polymarket_clob'],
  },

  // ── Aerodrome AMM (Base) ─────────────────────────────────────────────
  {
    id: 'aerodrome-eth-usdc-lp',
    text: 'Run an LP position on Aerodrome ETH/USDC pool on Base. $20k. Concentrated around current price. Rebalance only if price drifts >5% off the range.',
    capital_usd: 20_000,
    dd_cap_pct: 4,
    venues: ['aerodrome'],
  },

  // ── Aave lending (Base) ──────────────────────────────────────────────
  {
    id: 'aave-stables-yield',
    text: 'Deposit stables into Aave on Base for yield. $20k. Keep it simple. No leverage. No trades. Just supply and earn.',
    capital_usd: 20_000,
    dd_cap_pct: 1,
    venues: ['aave_v3'],
  },
]

/** Lookup by id; throws if unknown. */
export function getIntent(id: string): UserIntent {
  const i = STANDARD_USER_INTENTS.find((i) => i.id === id)
  if (!i) throw new Error(`unknown user intent id: ${id}`)
  return i
}
