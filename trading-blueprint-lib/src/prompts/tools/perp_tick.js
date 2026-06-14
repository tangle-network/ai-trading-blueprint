#!/usr/bin/env node
// EVM perp trading tick (strategy_type "perp" — GMX v2 / Vertex perps on
// Arbitrum). This used to be an always-skip stub that only proved the venue
// surface was inspectable; it now mirrors the hyperliquid family's model-driven
// architecture so the bot actually decides direction, sizes within risk caps,
// and submits a perp intent.
//
// Decision architecture (identical contract to hyperliquid_tick.js):
//   1. Fail-closed RISK GUARDS run FIRST and stay deterministic — the
//      config-incomplete guard (wrong chain / missing venue / non-paper), the
//      drawdown circuit breaker (skip when flat, flatten when in a position),
//      and the leverage + position-size envelope (perps.max_leverage default 2,
//      perps.max_position_pct default 5% of NAV). Risk never asks the model and
//      the model can never widen any of these caps — size is clamped at the call
//      site regardless of model output.
//   2. Inside whatever the guards permit, the MODEL is the alpha source: it
//      picks DIRECTION (long/short/skip when flat; hold/close when in a
//      position) and a size_fraction of the already-capped notional envelope.
//      RSI/EMA/funding/returns are inputs to the model, not the decision.
//   3. FAIL CLOSED: gated on agenticDecisionsEnabled(). The old risk-aware
//      no-trade evidence survives as the deterministic baseline
//      (TRADING_AGENTIC_DECISIONS=0) so eval/replay stays reproducible. A live
//      model failure HOLDS an open position / SKIPS when flat — it never
//      silently trades a hidden rule.

const t = require('/home/agent/tools/tick-common');
const { agenticDecision, agenticDecisionsEnabled } = require('/home/agent/tools/agentic-decision');

// Perp venues this family can route to. The bot's available_protocols (and the
// optional perps.venues override) constrain which of these are actually usable.
const EVM_PERP_VENUES = ['gmx_v2', 'vertex'];

// Asset universe scanned when flat. ETH first (deepest GMX/Vertex perp), then
// BTC. The model decides long/short/skip on the first asset with enough candle
// history; a "skip" is a real no-trade decision, not a reason to keep shopping.
const PERP_ASSETS = ['ETH', 'BTC'];

async function safeApi(api, method, path, body) {
  try {
    return t.body(await api.apiCall(method, path, body));
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function protocolList(config) {
  const configured = config.strategy_config || {};
  return Array.isArray(configured.available_protocols)
    ? configured.available_protocols.map(String)
    : ['gmx_v2', 'vertex'];
}

function priceFor(prices, symbol) {
  const entries = Array.isArray(prices.prices) ? prices.prices : [];
  const match = entries.find((entry) => String(entry?.token || '').toUpperCase() === symbol);
  return t.asNumber(match?.price_usd ?? prices[symbol] ?? prices[symbol.toLowerCase()], null);
}

// Compact, model-legible momentum view of the candle history beyond the single
// RSI/EMA scalars (mirrors hyperliquid_tick priceFeatures): recent returns so
// the model can reason about trend without being handed an 80-element array.
function priceFeatures(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return {};
  const last = closes[closes.length - 1];
  const ago = (n) => (closes.length > n ? closes[closes.length - 1 - n] : null);
  const pct = (from) => (Number.isFinite(from) && from > 0 ? ((last - from) / from) * 100 : null);
  return {
    return_1h_pct: pct(ago(1)),
    return_6h_pct: pct(ago(6)),
    return_24h_pct: pct(ago(24)),
  };
}

// True when a portfolio position is an open perp leg (LongPerp/ShortPerp) on one
// of this bot's EVM perp venues. The paper portfolio tags perp legs with
// position_type 'longperp'/'shortperp' (PositionType serialization) and the
// venue as the protocol; we accept any non-zero perp leg on gmx_v2/vertex.
function isPerpPosition(position) {
  if (!position || t.asNumber(position.amount, 0) === 0) return false;
  const protocol = String(position.protocol || '').trim().toLowerCase();
  if (!EVM_PERP_VENUES.includes(protocol)) return false;
  const type = String(position.position_type || '').trim().toLowerCase();
  return type.includes('perp') || type === 'long' || type === 'short';
}

function perpSide(position) {
  const type = String(position.position_type || '').trim().toLowerCase();
  if (type.includes('short')) return 'short';
  if (type.includes('long')) return 'long';
  return t.asNumber(position.amount, 0) >= 0 ? 'long' : 'short';
}

function perpNotional(position) {
  const explicit = t.asNumber(position.notional_usd ?? position.value_usd ?? position.valueUsd, null);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const amount = Math.abs(t.asNumber(position.amount, 0));
  const price = t.asNumber(position.current_price ?? position.price_usd ?? position.entry_price, null);
  return Number.isFinite(price) && price > 0 ? amount * price : 0;
}

function perpPnl(position) {
  return t.asNumber(position.unrealized_pnl ?? position.unrealized_pnl_usd ?? position.pnl, 0);
}

// Best-available USD/asset price for an open perp position (mark/current first,
// entry as a last resort). Used as the close intent's mark_price so the paper
// executor can value the close fill.
function perpPrice(position) {
  return t.asNumber(position.current_price ?? position.price_usd ?? position.mark_price ?? position.entry_price, null);
}

function perpAsset(position) {
  const token = String(position.symbol || position.token || '').toUpperCase();
  // Portfolio may carry the chain address; map the common ones back to a symbol.
  if (token === 'ETH' || token === 'WETH') return 'ETH';
  if (token === 'BTC' || token === 'WBTC' || token === 'CBBTC') return 'BTC';
  return token || 'ETH';
}

// The leverage + position-size envelope. These are RISK caps — read once,
// deterministic, and the model can never widen them. Returns the max notional
// the strategy may open this tick.
//   * max_position_pct: % of NAV the position notional may reach (default 5%).
//   * max_leverage: notional / margin ceiling (default 2x).
// Margin available for a perp is the NAV (paper perps collateralize from the
// vault), so the leverage ceiling is NAV * maxLeverage; the binding cap is
// whichever of the two is smaller.
function sizingEnvelope(perps, harness, totalNav) {
  const sizing = (harness && harness.position_sizing) || {};
  const positionFraction = t.asNumber(sizing.fraction, 0.1);
  const minOrderUsd = t.asNumber((harness && harness.min_order_usd) ?? perps.min_order_usd, 10);
  const maxLeverage = Math.max(1, t.asNumber(perps.max_leverage, 2));
  const maxPositionPct = Math.max(0, t.asNumber(perps.max_position_pct, 5));

  // Legacy fraction-of-capital target, hard-capped by the mandate's
  // max_position_pct of NAV so the model can never size past the risk ceiling.
  const fractionNotional = totalNav * positionFraction;
  const positionPctNotional = totalNav > 0 ? totalNav * (maxPositionPct / 100) : 0;
  const cappedByPct = Math.min(fractionNotional, positionPctNotional);
  // Margin/leverage ceiling: a paper perp is collateralized by NAV and may not
  // exceed NAV * maxLeverage.
  const marginLeverageCeiling = totalNav > 0 ? totalNav * maxLeverage : cappedByPct;
  const maxNotional = Math.max(0, Math.min(cappedByPct, marginLeverageCeiling));

  return { maxLeverage, maxPositionPct, minOrderUsd, positionFraction, maxNotional };
}

// Effective leverage of a notional against NAV, clamped to the cap. This is the
// integer leverage threaded into intent.metadata.leverage (the execute route's
// PerpsContext reads it as a u64) — never exceeds maxLeverage.
function leverageForNotional(notional, totalNav, maxLeverage) {
  if (totalNav <= 0) return 1;
  const raw = Math.ceil(notional / totalNav);
  return Math.max(1, Math.min(maxLeverage, Number.isFinite(raw) ? raw : 1));
}

// Build the perp intent the execute route understands for gmx_v2/vertex:
//   target_protocol = the chosen venue, token_out = asset symbol, action =
//   open_long/open_short/close_long/close_short, and metadata carrying the perp
//   contract: asset (string), leverage (u64), stop_loss_distance (fraction).
function buildPerpIntent({ config, strategyId, venue, asset, action, notional, leverage, stopLossPct, rationale, signals, reduceOnly, markPrice }) {
  const price = t.asNumber(markPrice, null);
  return {
    strategy_id: strategyId || `tick-${config.bot_id || 'bot'}`,
    target_protocol: venue,
    token_in: 'USDC',
    token_out: asset,
    min_amount_out: '0',
    action,
    amount_in: String(notional),
    metadata: {
      asset,
      leverage,
      // The execute route reads stop_loss_distance (a fraction) OR
      // stop_loss_distance_pct/stop_loss_pct; we thread both the fraction and
      // the pct so the perps policy's require_stop_loss is always satisfiable.
      stop_loss_distance: stopLossPct / 100,
      stop_loss_pct: stopLossPct,
      notional_usdc: String(notional),
      // Entry mark price (USD/asset). The paper executor values the perp fill
      // as notional/price asset units at this entry, so PnL realizes as
      // notional × price-move × direction (not a spot swap). Omitted when the
      // tick has no live price — the executor then fails closed and rejects.
      mark_price: price !== null && price > 0 ? String(price) : undefined,
      reduce_only: reduceOnly || undefined,
      signal: rationale,
      signals: signals || {},
      runner_signal: rationale || null,
    },
  };
}

// ---- ALPHA: model decides DIRECTION + SIZE inside the guard envelope ----
// Flat: long / short / skip. In a position: hold / close. The model never sees
// the leverage or position-size caps as negotiable — it returns a size_fraction
// of the already-capped notional envelope. Fails closed (null → hold/skip).
async function decideAgentic({
  env, venue, openPosition, asset, currentPrice, closes, currentRsi, shortEma, longEma,
  funding, totalNav, envelope, maxDrawdownPct, externalSignals,
}) {
  const holding = Boolean(openPosition);
  const candidates = holding ? ['hold', 'close'] : ['long', 'short', 'skip'];

  const evidence = {
    asset,
    venue,
    price: currentPrice,
    rsi_14: currentRsi,
    ema_12: shortEma,
    ema_26: longEma,
    ema_gap_pct: shortEma && longEma ? ((shortEma - longEma) / longEma) * 100 : null,
    ...priceFeatures(closes),
    funding_rate: t.asNumber(funding?.funding_rate ?? funding?.fundingRate ?? funding?.predicted_funding, null),
    total_nav_usd: totalNav,
    external_signals: externalSignals,
    position: holding
      ? {
          side: perpSide(openPosition),
          notional_usd: perpNotional(openPosition),
          unrealized_pnl_usd: perpPnl(openPosition),
          unrealized_pct: perpNotional(openPosition) > 0
            ? (perpPnl(openPosition) / perpNotional(openPosition)) * 100
            : null,
          leverage: totalNav > 0 ? perpNotional(openPosition) / totalNav : null,
        }
      : null,
  };

  const decisionOut = await agenticDecision(
    {
      family: 'perp',
      candidates,
      sizing: { max_fraction: 1, max_notional_usd: envelope.maxNotional, min_notional_usd: envelope.minOrderUsd },
      mandate: {
        max_drawdown_pct: maxDrawdownPct,
        max_leverage: envelope.maxLeverage,
        max_position_pct: envelope.maxPositionPct,
        asset,
        venue,
      },
      position: holding ? { side: evidence.position.side, notional_usd: evidence.position.notional_usd } : { side: 'flat' },
      evidence,
    },
    { env },
  );

  const meta = decisionOut
    ? {
        decided_by: 'model',
        model: decisionOut.model,
        confidence: decisionOut.confidence,
        model_rationale: decisionOut.rationale,
        key_signals: decisionOut.key_signals,
        prompt_hash: decisionOut.prompt_hash,
      }
    : null;

  // Fail closed: a model failure HOLDS an open position / skips when flat. It
  // never falls back to a hidden directional rule (the decorative-AI bug).
  if (!decisionOut) {
    if (holding) return { clear: false, reason: 'model-unavailable-hold', decided_by: 'model', model_unavailable: true };
    return { clear: false, reason: 'model-unavailable-skip', decided_by: 'model', model_unavailable: true };
  }

  if (holding) {
    if (decisionOut.action === 'close') {
      const side = perpSide(openPosition);
      const notional = perpNotional(openPosition);
      return {
        clear: true,
        action: side === 'short' ? 'close_short' : 'close_long',
        venue,
        asset,
        notional,
        markPrice: currentPrice,
        leverage: leverageForNotional(notional, totalNav, envelope.maxLeverage),
        reduce_only: true,
        rationale: 'model-exit',
        signals: { price: currentPrice },
        ...meta,
      };
    }
    return { clear: false, reason: 'model-hold', ...meta };
  }

  if (decisionOut.action === 'skip') {
    return { clear: false, reason: 'model-no-trade', ...meta };
  }

  // long / short: size is the model's fraction of the already-capped envelope.
  const notional = Math.min(
    envelope.maxNotional,
    Math.max(0, decisionOut.size_fraction) * envelope.maxNotional,
  );
  if (notional < envelope.minOrderUsd) {
    return {
      clear: false,
      reason: 'model-size-below-minimum',
      target_notional_usdc: notional,
      min_order_usd: envelope.minOrderUsd,
      ...meta,
    };
  }
  return {
    clear: true,
    action: decisionOut.action === 'long' ? 'open_long' : 'open_short',
    venue,
    asset,
    notional,
    markPrice: currentPrice,
    leverage: leverageForNotional(notional, totalNav, envelope.maxLeverage),
    rationale: 'model-entry',
    signals: { rsi_14: currentRsi, ema_12: shortEma, ema_26: longEma, price: currentPrice, confidence: decisionOut.confidence },
    ...meta,
  };
}

async function decide(ctx) {
  const { api, config, harness } = ctx;
  const strategyConfig = config.strategy_config || {};
  const protocols = protocolList(config);
  const protocolChainId = t.chainIdForProtocol(config, 'gmx_v2');
  const paperTrade = strategyConfig.paper_trade !== false;
  const env = process.env;
  const agentic = agenticDecisionsEnabled(env);

  const [portfolio, adapterList, prices, ethCandles, fundingResp] = await Promise.all([
    safeApi(api, 'POST', '/portfolio/state', {}),
    safeApi(api, 'GET', '/adapters'),
    safeApi(api, 'POST', '/market-data/prices', { tokens: ['ETH', 'BTC'] }),
    t.fetchCandles(api, 'ETH').catch((error) => ({ error: error.message || String(error), candles: [] })),
    safeApi(api, 'GET', '/market-data/funding?asset=ETH'),
  ]);

  const totalNav = t.asNumber(portfolio.total_value_usd, t.asNumber(strategyConfig.initial_capital_usd, 0));
  const perps = strategyConfig.perps || {};
  const evmPerpProtocols = protocols.filter((protocol) => EVM_PERP_VENUES.includes(protocol));
  const configuredVenues = Array.isArray(perps.venues) ? perps.venues.map(String) : evmPerpProtocols;
  // Usable venues = configured venues that are actually in available_protocols.
  const usableVenues = configuredVenues.filter((v) => protocols.includes(v) && EVM_PERP_VENUES.includes(v));
  const venue = usableVenues[0] || null;
  const maxLeverage = t.asNumber(perps.max_leverage, 2);
  const maxPositionPct = t.asNumber(perps.max_position_pct, 5);
  const maxDrawdownPct = t.mandateMaxDrawdownPct(config, harness, t.asNumber(perps.max_drawdown_pct, 10));
  const stopLossPct = t.asNumber(perps.stop_loss_pct, 5);

  const envelope = sizingEnvelope(perps, harness, totalNav);

  const missing = [];
  if (protocolChainId !== 42161) missing.push('protocol_chain_id must be 42161 for Arbitrum GMX/Vertex');
  if (!protocols.includes('gmx_v2')) missing.push('gmx_v2 protocol');
  if (!protocols.includes('vertex')) missing.push('vertex protocol');
  if (!paperTrade) missing.push('paper_trade=false');

  const positions = t.positionsOf(portfolio);
  const openPosition = positions.find(isPerpPosition) || null;

  const checkedState = {
    strategy_type: 'perp',
    paper_trade: paperTrade,
    protocol_chain_id: protocolChainId,
    available_protocols: protocols,
    venues: configuredVenues,
    usable_venues: usableVenues,
    selected_venue: venue,
    agentic_decisions_enabled: agentic,
    cross_venue_capability: {
      hyperliquid_available: protocols.includes('hyperliquid'),
      gmx_v2_chain_id: t.chainIdForProtocol(config, 'gmx_v2'),
      vertex_chain_id: t.chainIdForProtocol(config, 'vertex'),
      hyperliquid_chain_id: t.chainIdForProtocol(config, 'hyperliquid'),
    },
    perps: {
      max_leverage: maxLeverage,
      max_position_pct: maxPositionPct,
      max_notional_usd: envelope.maxNotional,
      stop_loss_pct: stopLossPct,
      order_type: perps.order_type || 'limit',
    },
    total_nav_usd: totalNav,
    max_drawdown_pct: maxDrawdownPct,
    open_position: openPosition
      ? { asset: perpAsset(openPosition), side: perpSide(openPosition), notional_usd: perpNotional(openPosition), unrealized_pnl_usd: perpPnl(openPosition) }
      : null,
    adapters_error: adapterList.error || null,
    portfolio_error: portfolio.error || null,
    market: {
      asset: 'ETH',
      eth_price_usd: priceFor(prices, 'ETH'),
      btc_price_usd: priceFor(prices, 'BTC'),
      eth_candles: Array.isArray(ethCandles) ? ethCandles.length : 0,
      candles_error: ethCandles && ethCandles.error ? ethCandles.error : null,
    },
  };

  const metrics = {
    portfolio_value_usd: totalNav,
    perp_protocol_chain_id: protocolChainId,
    perp_max_leverage: maxLeverage,
    perp_max_position_pct: maxPositionPct,
    perp_max_notional_usd: envelope.maxNotional,
    configured_protocols_count: protocols.length,
    usable_venue_count: usableVenues.length,
    missing_config_count: missing.length,
    eth_price_usd: checkedState.market.eth_price_usd,
    eth_candle_count: checkedState.market.eth_candles,
    open_perp_position: openPosition ? 1 : 0,
  };

  const provenanceOf = (setup) =>
    setup && setup.decided_by === 'model'
      ? {
          decided_by: 'model',
          model: setup.model,
          confidence: setup.confidence,
          model_rationale: setup.model_rationale,
          key_signals: setup.key_signals,
          prompt_hash: setup.prompt_hash,
        }
      : {};

  // ---- RISK GUARD 1: config-incomplete (real risk — wrong chain / venue) ----
  if (missing.length > 0) {
    return {
      decision: { action: 'skip', reason: 'perp-config-incomplete', missing_config: missing },
      checkedState,
      metrics,
    };
  }

  // ---- RISK GUARD 2: no usable perp venue → model-reasoned skip, not a trade ----
  if (!venue) {
    return {
      decision: { action: 'skip', reason: 'perp-no-usable-venue', configured_venues: configuredVenues },
      checkedState,
      metrics,
    };
  }

  // ---- RISK GUARD 3: drawdown circuit breaker — flatten if holding, else skip ----
  const breakerTripped = await t.circuitBreakerTripped(api, maxDrawdownPct);
  if (breakerTripped) {
    if (openPosition) {
      const side = perpSide(openPosition);
      const notional = perpNotional(openPosition);
      const intent = buildPerpIntent({
        config,
        strategyId: strategyConfig.strategy_id,
        venue: String(openPosition.protocol || venue).toLowerCase(),
        asset: perpAsset(openPosition),
        action: side === 'short' ? 'close_short' : 'close_long',
        notional,
        leverage: leverageForNotional(notional, totalNav, maxLeverage),
        markPrice: perpPrice(openPosition),
        stopLossPct,
        rationale: 'drawdown-derisk-exit',
        signals: { max_drawdown_pct: maxDrawdownPct },
        reduceOnly: true,
      });
      const submit = await t.submitIntent(api, config, intent);
      return {
        decision: {
          action: submit.approved ? 'trade' : 'skip',
          reason: submit.approved ? 'drawdown-derisk-exit' : 'drawdown-exit-rejected',
          intent,
          submit,
        },
        checkedState,
        metrics,
        resultExtra: { trade_action: { attempted: true, intent, submit } },
      };
    }
    return {
      decision: { action: 'skip', reason: 'circuit-breaker-tripped-flat', max_drawdown_pct: maxDrawdownPct },
      checkedState,
      metrics,
    };
  }

  // ---- RISK GUARD 4: size envelope must clear the minimum order (when flat) ----
  if (!openPosition && envelope.maxNotional < envelope.minOrderUsd) {
    return {
      decision: {
        action: 'skip',
        reason: 'perp-target-notional-below-minimum',
        target_notional_usdc: envelope.maxNotional,
        min_order_usd: envelope.minOrderUsd,
      },
      checkedState,
      metrics,
    };
  }

  // ---- Deterministic baseline (model disabled): risk-aware, no directional bet ----
  // Eval/replay reproducibility path. The old stub's "inspected the venue, took
  // no funding-edge trade" evidence is the honest no-trade baseline when the
  // model layer is off — we never silently open a position from a hidden rule.
  if (!agentic) {
    return {
      decision: {
        action: openPosition ? 'hold' : 'skip',
        reason: openPosition ? 'baseline-holding-no-exit-signal' : 'baseline-no-perp-edge',
        venue,
        agentic_disabled: true,
      },
      checkedState,
      metrics,
    };
  }

  // ---- ALPHA: model decides direction/size inside the envelope ----
  const externalSignals = (checkedState.external_signal_evidence || {}).external_signals || [];

  let setup;
  if (openPosition) {
    const asset = perpAsset(openPosition);
    const currentPrice = priceFor(prices, asset);
    const closes = asset === 'ETH' && Array.isArray(ethCandles)
      ? ethCandles
      : await t.fetchCandles(api, asset).catch(() => []);
    setup = await decideAgentic({
      env,
      venue: String(openPosition.protocol || venue).toLowerCase(),
      openPosition,
      asset,
      currentPrice,
      closes,
      currentRsi: t.rsi(closes, 14),
      shortEma: t.ema(closes, 12),
      longEma: t.ema(closes, 26),
      funding: fundingResp,
      totalNav,
      envelope,
      maxDrawdownPct,
      externalSignals,
    });
  } else {
    for (const asset of PERP_ASSETS) {
      const currentPrice = priceFor(prices, asset);
      const closes = asset === 'ETH' && Array.isArray(ethCandles)
        ? ethCandles
        : await t.fetchCandles(api, asset).catch(() => []);
      if (!currentPrice || closes.length < 30) continue;
      setup = await decideAgentic({
        env,
        venue,
        openPosition: null,
        asset,
        currentPrice,
        closes,
        currentRsi: t.rsi(closes, 14),
        shortEma: t.ema(closes, 12),
        longEma: t.ema(closes, 26),
        funding: fundingResp,
        totalNav,
        envelope,
        maxDrawdownPct,
        externalSignals,
      });
      // The model already weighed long/short/skip with full context, so we honor
      // its call rather than re-rolling on the next asset.
      break;
    }
    if (!setup) {
      setup = { clear: false, reason: 'perp-no-asset-with-history' };
    }
  }

  const provenance = provenanceOf(setup);

  if (!setup.clear) {
    return {
      decision: {
        action: setup.reason === 'model-hold' ? 'hold' : 'skip',
        reason: setup.reason || 'no-clear-perp-setup',
        setup,
        ...provenance,
      },
      checkedState,
      metrics,
    };
  }

  // ---- Submit the model's bounded, clamped intent (validate → execute) ----
  const intent = buildPerpIntent({
    config,
    strategyId: strategyConfig.strategy_id,
    venue: setup.venue,
    asset: setup.asset,
    action: setup.action,
    notional: setup.notional,
    leverage: setup.leverage,
    markPrice: setup.markPrice,
    stopLossPct,
    rationale: setup.rationale,
    signals: setup.signals,
    reduceOnly: setup.reduce_only,
  });

  const submit = await t.submitIntent(api, config, intent);
  metrics.perp_intent_notional_usd = setup.notional;
  metrics.perp_intent_leverage = setup.leverage;

  return {
    decision: {
      action: submit.approved ? 'trade' : 'skip',
      reason: submit.approved ? setup.rationale : 'perp-validation-rejected',
      intent,
      submit,
      ...provenance,
    },
    checkedState,
    metrics,
    resultExtra: { trade_action: { attempted: true, intent, submit } },
  };
}

t.runTick('perp', decide);
