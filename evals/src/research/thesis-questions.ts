/**
 * Standard thesis questions for the research-depth eval (eval #3 in
 * SPEC.md §5).
 *
 * Each question forces the bot to research across a different asset
 * class + source type. The judge scores the bot's answer on source
 * count, source diversity, recency, citation accuracy, and narrative
 * coherence.
 *
 * Adding a question: keep the spread — crypto / on-chain / macro /
 * prediction-markets / equities / sentiment. A bot that aces three but
 * fails on the other two has a research breadth gap we'd want to know.
 */

export interface ThesisQuestion {
  id: string
  /** The freeform question, asked to the bot like a user would ask. */
  question: string
  /** Expected breadth of sources — the judge penalises bots that miss
   *  ANY of these source-class hits. */
  expected_source_classes: SourceClass[]
  /** Time-sensitive — answer is wrong if it's older than this many hours. */
  required_recency_hours: number
  /** A specific concrete fact the bot's answer should engage with. The
   *  judge checks for substantive engagement, not exact-match. */
  must_engage_with: string
}

export type SourceClass =
  | 'crypto_news'
  | 'on_chain_metrics'
  | 'macro_calendar'
  | 'prediction_markets'
  | 'equity_research'
  | 'social_sentiment'
  | 'protocol_docs'
  | 'token_unlocks'

export const STANDARD_THESIS_QUESTIONS: ThesisQuestion[] = [
  {
    id: 'btc-week-narrative',
    question:
      "What's the dominant BTC narrative this week? Cite specific sources and their dates. I want to know whether to lean long or stay flat.",
    expected_source_classes: ['crypto_news', 'on_chain_metrics', 'social_sentiment'],
    required_recency_hours: 168, // 7 days
    must_engage_with: 'price action + at least one specific catalyst or counter-narrative from the last 7 days',
  },
  {
    id: 'eth-staking-yield-real',
    question:
      'Is the current ETH staking yield (~3.5% nominal) attractive on a risk-adjusted basis, given ETH inflation and the ETH/BTC trend? Show your work.',
    expected_source_classes: ['on_chain_metrics', 'protocol_docs', 'crypto_news'],
    required_recency_hours: 168,
    must_engage_with: 'ETH issuance rate + ETH/BTC trend + opportunity cost framing',
  },
  {
    id: 'fomc-next-rate-decision',
    question:
      "When is the next FOMC rate decision, what's currently priced in (fed funds futures), and what's the realistic upside/downside surprise vs the consensus? I'm thinking about crypto exposure into that print.",
    expected_source_classes: ['macro_calendar', 'crypto_news'],
    required_recency_hours: 168,
    must_engage_with: 'a specific date + market-implied probability + asymmetric scenario reasoning',
  },
  {
    id: 'polymarket-2024-election-still-tradable',
    question:
      "Are there still tradable edges on Polymarket's biggest political markets right now? What's the highest-volume market with mid-range odds (0.25-0.75) that might be mispriced, and why?",
    expected_source_classes: ['prediction_markets', 'crypto_news'],
    required_recency_hours: 72,
    must_engage_with: 'a specific Polymarket market with volume + odds + a mispricing thesis',
  },
  {
    id: 'sol-vs-base-l2-ecosystem',
    question:
      'Which ecosystem is winning developer mindshare right now — Solana or Base? I want on-chain evidence, not vibes. TVL, DEX volume, stablecoin supply, and active addresses week-over-week.',
    expected_source_classes: ['on_chain_metrics', 'crypto_news', 'protocol_docs'],
    required_recency_hours: 168,
    must_engage_with: 'numeric comparison across at least three of: TVL, DEX volume, stablecoin supply, active addresses',
  },
  {
    id: 'major-token-unlock-30d',
    question:
      "What significant token unlocks (>5% of float) are coming in the next 30 days? Rank them by likely supply pressure. I want to short-bias those tokens into the unlock.",
    expected_source_classes: ['token_unlocks', 'crypto_news'],
    required_recency_hours: 72,
    must_engage_with: 'at least 3 specific tokens with unlock dates + % of float',
  },
]
