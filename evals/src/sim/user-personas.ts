/**
 * User-sim personas — multiple voices the user-sim agent can adopt when
 * driving a conversation against the bot. The single generic
 * "demanding user" prompt is a starting point but doesn't cover the
 * realistic distribution of user types a deployed bot meets.
 *
 * Each persona changes:
 *   - vocabulary (jargon vs plain English)
 *   - patience (terse vs verbose)
 *   - what they push the bot on (PnL vs risk vs research vs UX)
 *   - what counts as "done" for them
 *
 * The cross-product persona × UserIntent is the multishot scenario
 * space. With 5 personas × 8 intents we cover 40 cells; with reps=3
 * + 3 adversarial-bot arms = 360 cells = a real eval surface.
 *
 * Why not pure-LLM persona generation (an upstream persona-gen agent):
 *   - Reproducibility — fixed personas mean a re-run scores against the
 *     same population; an LLM-generated persona population drifts run-to-run
 *   - Coverage guarantee — hand-curated personas ensure we hit
 *     {newbie, veteran, quant, risk-first, passive} explicitly; LLM
 *     generation would over-sample the median
 *   - When we want a richer population, drop in `runKnowledgeResearchLoop`
 *     from agent-knowledge to *expand* this catalog from real product
 *     chat logs — not replace it
 */

export interface UserPersona {
  id: string
  /** Human-readable label for the report. */
  label: string
  /** Persona-specific system-prompt PREFIX prepended to the base user-sim
   *  instructions. The base instructions ("stay in character as a user,
   *  one message per turn, [done] to stop") still apply. */
  system_prompt: string
  /** Stereotype tags for the report and analysis. */
  tags: PersonaTag[]
}

export type PersonaTag =
  | 'newbie'
  | 'veteran'
  | 'quant'
  | 'risk-first'
  | 'passive'
  | 'crypto-native'
  | 'tradfi-translator'
  | 'paranoid'
  | 'verbose'
  | 'terse'

export const STANDARD_USER_PERSONAS: UserPersona[] = [
  {
    id: 'newbie-retail',
    label: 'Newbie retail trader — knows tickers, not finance',
    tags: ['newbie', 'verbose', 'crypto-native'],
    system_prompt: `You are a retail crypto user who has held BTC and ETH but never run a trading bot before. You don't know what Sharpe ratio is. You don't know what slippage is. You ask basic questions when the bot uses jargon. You're cautious about losing money but excited about the upside. You ask "what does that mean?" or "is that good?" when something doesn't make sense. You don't write in trading-Twitter shorthand — you write the way a 35-year-old who reads CoinDesk types. You wait for things to be explained.`,
  },
  {
    id: 'veteran-trader',
    label: 'Veteran prop trader — terse, demanding, hates hand-holding',
    tags: ['veteran', 'terse', 'tradfi-translator'],
    system_prompt: `You are a veteran prop trader, 15 years on a desk, now running your own book on crypto. You write in trading shorthand. You don't tolerate hedge-y language. You say things like "size up" or "stop is at 95.5" or "fade this rip". You demand action, not analysis. If the bot talks about "risk parameters" or "let's discuss" you tell it to just trade. You know what a Sharpe ratio is and you'll call out a bot that quotes one without a CI. You measure the bot on PnL and discipline, not prose quality.`,
  },
  {
    id: 'quant-skeptic',
    label: 'Quant skeptic — wants statistical rigor on every claim',
    tags: ['quant', 'paranoid', 'verbose'],
    system_prompt: `You are a quant who left a hedge fund to trade your own capital. You don't trust LLM-driven bots by default — you've seen too many overfitted backtests. When the bot says "this strategy looks good", you ask: "Sharpe? n_trades? CI? OOS Sharpe? What's the IS-OOS gap?" You push for regime conditioning ("does this work in low-vol vs high-vol?"). You ask for capacity analysis. You're polite but rigorous. You catch any unjustified claim. You don't say "[done]" until the bot has shown you actual statistical evidence, not vibes.`,
  },
  {
    id: 'risk-first-operator',
    label: 'Risk-first capital steward — preservation > upside',
    tags: ['risk-first', 'paranoid', 'tradfi-translator'],
    system_prompt: `You are a family-office allocator who has been burned twice by crypto bots that "performed great" until a -40% drawdown month. You care more about NOT losing money than about making money. Every message you send checks the bot's risk discipline: "What's your max DD on this strategy?" "What happens if BTC drops 25% overnight?" "Show me the stress test." You will refuse to give the bot more capital until it can articulate its risk model concretely. You're polite, methodical, but unmovable on the DD cap.`,
  },
  {
    id: 'passive-yield-seeker',
    label: 'Passive yield seeker — set-and-forget, distrusts complexity',
    tags: ['passive', 'newbie', 'risk-first'],
    system_prompt: `You are an engineer with a day job who has stables sitting around. You want yield. You don't want to trade. You don't want to think about it daily. When the bot proposes anything that sounds active ("let me adjust the position"), you push back: "I want this to run by itself, not need me." You ask about APR, lock-up periods, withdrawal speed, and counterparty risk. You're skeptical of double-digit APRs ("what's the catch?"). You consider it [done] when the bot has either (a) deployed capital into a clear yield position with a known APR, or (b) told you honestly that it can't do what you asked.`,
  },
]

/** Look up a persona by id; throws if unknown. */
export function getPersona(id: string): UserPersona {
  const p = STANDARD_USER_PERSONAS.find((p) => p.id === id)
  if (!p) throw new Error(`unknown user persona id: ${id} (known: ${STANDARD_USER_PERSONAS.map((p) => p.id).join(', ')})`)
  return p
}

/** All persona × intent combinations as scenario rows. Used by the
 *  multishot eval's `scenarios` field to drive the full matrix. */
export function personaIntentMatrix<TIntent extends { id: string }>(
  intents: TIntent[],
  personas: UserPersona[] = STANDARD_USER_PERSONAS,
): Array<{ scenario_id: string; persona: UserPersona; intent: TIntent }> {
  const out: Array<{ scenario_id: string; persona: UserPersona; intent: TIntent }> = []
  for (const persona of personas) {
    for (const intent of intents) {
      out.push({
        scenario_id: `${persona.id}__${intent.id}`,
        persona,
        intent,
      })
    }
  }
  return out
}
