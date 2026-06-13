#!/usr/bin/env node
// Model-driven prediction-market tick (strategy_type "prediction", Polymarket CLOB).
//
// Decision architecture — same spine as dex_tick.js, so the decorative-AI bug it
// fixed cannot reappear here:
//   1. Fail-closed RISK GUARDS run first and are always deterministic — drawdown
//      breaker, min-order size, no-markets / no-cash / missing-data skips. The
//      model never widens or overrides them.
//   2. Inside the guard envelope the MODEL is the alpha source: it reads the live
//      market shortlist (implied probabilities), open conditional-token positions,
//      external signals and the mandate, and picks ONE action for the single
//      pre-ranked best market — enter_yes / enter_no / skip — plus a size.
//   3. There is NO prior deterministic prediction strategy to preserve, so the
//      disabled/eval path (TRADING_AGENTIC_DECISIONS=0) is an honest no-trade
//      baseline that still satisfies the schema-v1 contract.
//
// Market + side selection (why this shape): agenticDecision returns a single
// {action, size_fraction}. Rather than hand the model a free-form market id (which
// it can hallucinate), we DETERMINISTICALLY rank the discovered markets and feed
// the model the full shortlist as evidence but bind the trade to the top-1 ranked
// market. The model's action encodes the side: enter_yes → YES token, enter_no →
// NO token, skip → no trade. This keeps agentic_decision.js unmodified, makes the
// choice auditable (the rank is reproducible, the side is the model's), and stays
// fail-closed (null / 'skip' → no trade).

const t = require('/home/agent/tools/tick-common');
const { agenticDecision, agenticDecisionsEnabled } = require('/home/agent/tools/agentic-decision');

const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events?closed=false&order=volume&ascending=false&limit=';
const POLYGON_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const DISCOVER_LIMIT = 10;
const SHORTLIST_SIZE = 8;
// Markets too close to resolution carry no edge and dominate the volume sort.
const MIN_PROB = 0.08;
const MAX_PROB = 0.92;

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Discover open prediction markets from Gamma, newest pricing from the per-market
// CLOB midpoint (implied probability). Wrapped fail-closed: any network/parse
// failure yields an empty shortlist and the tick skips rather than guesses.
async function discoverMarkets(limit) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') return [];
  let events;
  try {
    const res = await fetchImpl(`${GAMMA_EVENTS_URL}${limit}`, {
      headers: { 'user-agent': 'TradingAgent/1.0', accept: 'application/json' },
    });
    if (!res || typeof res.json !== 'function' || !res.ok) return [];
    events = await res.json();
  } catch {
    return [];
  }
  if (!Array.isArray(events)) return [];

  const markets = [];
  for (const event of events) {
    const eventMarkets = Array.isArray(event && event.markets) ? event.markets : [];
    for (const m of eventMarkets) {
      const clobTokenIds = parseJsonArray(m.clobTokenIds);
      if (clobTokenIds.length < 2 || !clobTokenIds[0] || !clobTokenIds[1]) continue;
      const prices = parseJsonArray(m.outcomePrices);
      const yesPrice = num(prices[0]);
      if (yesPrice === null || yesPrice <= MIN_PROB || yesPrice >= MAX_PROB) continue;
      const volume = num(m.volume, 0);
      markets.push({
        condition_id: String(m.id || m.conditionId || ''),
        question: String(m.question || event.title || '').slice(0, 140),
        yes_price: yesPrice,
        no_price: num(prices[1], 1 - yesPrice),
        volume,
        liquidity: num(m.liquidity, 0),
        clob_token_ids: [String(clobTokenIds[0]), String(clobTokenIds[1])],
        end_date: m.endDate || null,
      });
    }
  }

  // Refresh the YES midpoint for the volume-leading shortlist from the live CLOB
  // (more current than Gamma's snapshot). Best-effort per market.
  const ranked = markets.sort((a, b) => b.volume - a.volume).slice(0, SHORTLIST_SIZE);
  await Promise.all(
    ranked.map(async (m) => {
      try {
        const res = await fetchImpl(`https://clob.polymarket.com/midpoint?token_id=${m.clob_token_ids[0]}`, {
          headers: { 'user-agent': 'TradingAgent/1.0', accept: 'application/json' },
        });
        if (res && typeof res.json === 'function' && res.ok) {
          const data = await res.json();
          const mid = num(data && data.mid);
          if (mid !== null && mid > 0 && mid < 1) {
            m.yes_price = mid;
            m.no_price = 1 - mid;
          }
        }
      } catch {
        // keep the Gamma snapshot price
      }
    }),
  );
  return ranked.filter((m) => m.condition_id && m.yes_price > MIN_PROB && m.yes_price < MAX_PROB);
}

// Deterministic ranking → top-1 binds the trade. Prefer informative odds (further
// from a coin-flip = the market is making a claim) backed by real volume, so the
// model is reasoning about a tradeable market, not a thin/degenerate one.
function rankScore(m) {
  const decisiveness = Math.abs(m.yes_price - 0.5); // 0 (toss-up) .. ~0.42
  const liquidityWeight = Math.log10(Math.max(10, m.volume + m.liquidity));
  return decisiveness * liquidityWeight;
}

// Conditional-token positions currently held (non-spot exposure the strategy
// owns). The portfolio synthesizer / live vault labels these polymarket_clob or
// position_type conditional_token; we surface them so the model sees its book.
function conditionalPositions(portfolio) {
  return t.positionsOf(portfolio)
    .filter((p) => {
      const protocol = String(p.protocol || '').trim().toLowerCase();
      const positionType = String(p.position_type || '').trim().toLowerCase();
      return protocol === 'polymarket_clob' || positionType === 'conditional_token';
    })
    .map((p) => ({
      token: String(p.token || ''),
      amount: t.asNumber(p.amount, 0),
      value_usd: t.asNumber(p.value_usd ?? p.valueUsd ?? null, null),
      condition_id: (p.metadata && String(p.metadata.condition_id || '')) || null,
      outcome: (p.metadata && String(p.metadata.outcome || '')) || null,
    }))
    .filter((p) => p.amount > 0);
}

function compactSignals(ctx, checkedState, metrics) {
  try {
    const evidence = t.buildExternalSignalEvidence({
      config: ctx.config,
      family: 'prediction',
      checkedState,
      metrics,
    });
    const signals = Array.isArray(evidence.external_signals) ? evidence.external_signals : [];
    return signals.slice(0, 5).map((s) => ({ kind: s.kind, value: s.value, label: s.label }));
  } catch {
    return [];
  }
}

async function gather(ctx) {
  const { api } = ctx;
  const portfolio = t.body(await api.apiCall('POST', '/portfolio/state', {}));
  const totalNav = t.asNumber(portfolio.total_value_usd, 0);
  // Idle quote cash to deploy: USDC spot balance (paper synth + live vault both
  // surface seeded cash as a spot position).
  const idleCash = t.vaultSpotAmount(portfolio, POLYGON_USDC)
    || t.vaultSpotAmount(portfolio, t.pairTokens(ctx.config).usdc);
  const positions = conditionalPositions(portfolio);

  let markets = [];
  try {
    markets = await discoverMarkets(DISCOVER_LIMIT);
  } catch {
    markets = [];
  }
  const ranked = markets.slice().sort((a, b) => rankScore(b) - rankScore(a));
  const top = ranked[0] || null;

  const checkedState = {
    venue: 'polymarket_clob',
    total_nav_usd: totalNav,
    idle_cash_usd: idleCash,
    open_positions: positions.length,
    markets_discovered: markets.length,
    top_market: top
      ? { condition_id: top.condition_id, question: top.question, yes_price: top.yes_price, volume: top.volume }
      : null,
  };
  const metrics = {
    portfolio_value_usd: totalNav,
    positions_count: t.positionsOf(portfolio).length,
    markets_discovered: markets.length,
  };
  return { portfolio, totalNav, idleCash, positions, markets: ranked, top, checkedState, metrics };
}

async function decide(ctx) {
  const { harness, config } = ctx;
  const g = await gather(ctx);
  const { totalNav, idleCash, markets, top, checkedState, metrics } = g;

  const sizing = harness.position_sizing || {};
  const fraction = t.asNumber(sizing.fraction, 0.1);
  const minOrderUsd = t.asNumber(harness.min_order_usd, 10);
  const maxDrawdownPct = t.mandateMaxDrawdownPct(config, harness, 10);

  // ---- RISK GUARDS (deterministic, fail-closed, always run) ----
  // Prediction positions are illiquid conditional tokens with no clean
  // market-sell here; a tripped breaker therefore just halts NEW entries rather
  // than attempting a forced flatten that would cross a wide book.
  if (await t.circuitBreakerTripped(ctx.api, maxDrawdownPct)) {
    return { decision: { action: 'skip', reason: 'circuit-breaker-triggered', checkedState }, checkedState, metrics };
  }
  if (!markets.length || !top) {
    return { decision: { action: 'skip', reason: 'no-open-markets', checkedState }, checkedState, metrics };
  }
  if (!Number.isFinite(idleCash) || idleCash < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'idle-cash-below-minimum', checkedState }, checkedState, metrics };
  }
  const maxDeployUsd = Math.min(totalNav * fraction, idleCash);
  if (!Number.isFinite(maxDeployUsd) || maxDeployUsd < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'target-notional-below-minimum', checkedState }, checkedState, metrics };
  }

  // ---- ALPHA: model decides inside the guard envelope ----
  if (agenticDecisionsEnabled()) {
    return decideAgentic(ctx, { ...g, fraction, minOrderUsd, maxDrawdownPct, maxDeployUsd });
  }
  return decideDeterministic(ctx, { ...g });
}

async function decideAgentic(ctx, g) {
  const { positions, markets, top, totalNav, idleCash, checkedState, metrics, minOrderUsd, maxDrawdownPct, maxDeployUsd } = g;

  // The model sees the whole shortlist (so it can judge relative value) but the
  // trade is bound to the deterministic top-1. Side is the model's call.
  const shortlist = markets.slice(0, SHORTLIST_SIZE).map((m) => ({
    condition_id: m.condition_id,
    question: m.question,
    yes_price: Number(m.yes_price.toFixed(4)),
    no_price: Number((m.no_price ?? 1 - m.yes_price).toFixed(4)),
    volume_usd: Math.round(m.volume),
  }));

  const evidence = {
    candidate_market: {
      condition_id: top.condition_id,
      question: top.question,
      yes_implied_prob: Number(top.yes_price.toFixed(4)),
      no_implied_prob: Number((top.no_price ?? 1 - top.yes_price).toFixed(4)),
      volume_usd: Math.round(top.volume),
    },
    market_shortlist: shortlist,
    open_positions: positions.slice(0, 8),
    total_nav_usd: totalNav,
    idle_cash_usd: idleCash,
    market_signals: compactSignals(ctx, checkedState, metrics),
  };

  const candidates = ['enter_yes', 'enter_no', 'skip'];
  const decisionOut = await agenticDecision({
    family: 'prediction',
    candidates,
    sizing: { max_fraction: 1, max_notional_usd: maxDeployUsd, min_notional_usd: minOrderUsd },
    mandate: { max_drawdown_pct: maxDrawdownPct, venue: 'polymarket_clob' },
    position: { open_markets: positions.length, idle_cash_usd: idleCash },
    evidence,
  });

  // Fail closed: a model failure SKIPS — it never trades a hidden rule.
  if (!decisionOut) {
    return { decision: { action: 'skip', reason: 'model-no-edge', checkedState }, checkedState, metrics };
  }

  const meta = {
    decided_by: 'model',
    model: decisionOut.model,
    confidence: decisionOut.confidence,
    model_rationale: decisionOut.rationale,
    key_signals: decisionOut.key_signals,
    prompt_hash: decisionOut.prompt_hash,
  };

  if (decisionOut.action === 'skip') {
    return { decision: { action: 'skip', reason: 'model-no-edge', checkedState, ...meta }, checkedState, metrics };
  }

  const side = decisionOut.action === 'enter_yes' ? 'YES' : 'NO';
  const amountUsd = Math.min(maxDeployUsd, Math.max(0, decisionOut.size_fraction) * maxDeployUsd);
  if (amountUsd < minOrderUsd) {
    return { decision: { action: 'skip', reason: 'model-size-below-minimum', checkedState, ...meta }, checkedState, metrics };
  }

  return submit(ctx, { market: top, side, amountUsd, meta, checkedState, metrics });
}

// No prior deterministic prediction strategy exists, and a model-disabled run
// must not invent edge. This baseline is an honest no-trade that still satisfies
// the schema-v1 contract (decision.action + reason + checkedState).
function decideDeterministic(ctx, g) {
  const { checkedState, metrics } = g;
  return { decision: { action: 'skip', reason: 'prediction-no-model-baseline', checkedState }, checkedState, metrics };
}

// Build + submit a polymarket_clob BUY of the chosen outcome token. Mirrors
// submit_trade.js's intent shape; routed through tick-common's submitIntent so
// envelope/per-trade modes and the validate→execute path stay uniform with the
// other family ticks.
async function submit(ctx, { market, side, amountUsd, meta, checkedState, metrics }) {
  const tokenId = side === 'YES' ? market.clob_token_ids[0] : market.clob_token_ids[1];
  const price = side === 'YES' ? market.yes_price : (market.no_price ?? 1 - market.yes_price);
  if (!tokenId || !Number.isFinite(price) || price <= 0 || price >= 1) {
    return { decision: { action: 'skip', reason: 'market-pricing-unavailable', checkedState, ...meta }, checkedState, metrics };
  }
  // CLOB orders size in OUTCOME SHARES; cost ≈ shares × price. Convert the USD
  // budget into shares so the notional respects the deploy cap.
  const shares = amountUsd / price;
  if (!Number.isFinite(shares) || shares <= 0) {
    return { decision: { action: 'skip', reason: 'market-pricing-unavailable', checkedState, ...meta }, checkedState, metrics };
  }

  const intent = {
    strategy_id: `prediction-${(market.condition_id || 'mkt').slice(0, 12)}`,
    action: 'buy',
    token_in: POLYGON_USDC,
    token_out: tokenId,
    amount_in: shares.toString(),
    min_amount_out: '0',
    target_protocol: 'polymarket_clob',
    metadata: {
      token_id: tokenId,
      price,
      order_type: 'GTC',
      condition_id: market.condition_id,
      outcome: side,
      outcome_label: side,
      outcome_index: side === 'YES' ? 0 : 1,
      market_question: market.question,
      notional_usd: Number(amountUsd.toFixed(2)),
      signal: 'model-prediction-entry',
      runner_signal: 'model-prediction-entry',
      decided_by: meta.decided_by,
      model: meta.model,
      confidence: meta.confidence,
      model_rationale: meta.model_rationale,
      key_signals: meta.key_signals,
      prompt_hash: meta.prompt_hash,
    },
  };

  const submission = await t.submitIntent(ctx.api, ctx.config, intent);
  const decision = submission.approved
    ? { action: 'trade', reason: 'model-prediction-entry', intent, ...meta }
    : { action: 'skip', reason: 'submission-rejected', intent, ...meta };
  return { decision, checkedState, metrics, resultExtra: { trade_action: { attempted: true, ...submission } } };
}

t.runTick('prediction', decide);
