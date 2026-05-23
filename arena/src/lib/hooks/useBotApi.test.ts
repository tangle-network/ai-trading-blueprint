import { describe, expect, it } from 'vitest';
import { deriveTradeAmountOut, getTradeStatus, mapApiTrade } from './useBotApi';

describe('useBotApi trade mapping helpers', () => {
  it('uses backend execution valuation when the trade is priced', () => {
    const trade = mapApiTrade({
      id: 'trade-1',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'buy',
      token_in: 'USDC',
      token_out: 'WETH',
      amount_in: '1000',
      amount_out: '0.5',
      min_amount_out: '0.49',
      target_protocol: 'uniswap_v3',
      paper_trade: true,
      entry_price_usd: '2000',
      valuation_status: 'priced',
    }, 'Bot');

    expect(trade.amountOut).toBe(0.5);
    expect(trade.priceUsd).toBe(2000);
    expect(trade.assetIn.symbol).toBe('USDC');
    expect(trade.assetOut.symbol).toBe('WETH');
  });

  it('returns null for trade USD price when valuation is unavailable', () => {
    const trade = mapApiTrade({
      id: 'trade-2',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'buy',
      token_in: 'WETH',
      token_out: 'WBTC',
      amount_in: '2',
      amount_out: '0.05',
      min_amount_out: '0.05',
      target_protocol: 'uniswap_v3',
      paper_trade: true,
      valuation_status: 'unpriced',
    }, 'Bot');

    expect(trade.priceUsd).toBeNull();
  });

  it('normalizes known token addresses into display symbols and decimal amounts', () => {
    const trade = mapApiTrade({
      id: 'trade-3',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'sell',
      token_in: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      token_out: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amount_in: '160757812500000013',
      amount_out: '1',
      min_amount_out: '1',
      target_protocol: 'uniswap_v3',
      paper_trade: false,
      valuation_status: 'unpriced',
    }, 'Bot');

    expect(trade.tokenIn).toBe('WETH');
    expect(trade.tokenOut).toBe('USDC');
    expect(trade.assetIn.name).toBe('Wrapped Ether');
    expect(trade.assetOut.name).toBe('USD Coin');
    expect(trade.amountIn).toBeCloseTo(0.1607578125, 10);
    expect(trade.rawTokenIn).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
  });

  it('uses the bot chain id as a fallback when trade validation omits chain metadata', () => {
    const trade = mapApiTrade({
      id: 'trade-4',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'buy',
      token_in: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      token_out: '0x4200000000000000000000000000000000000006',
      amount_in: '1000000',
      amount_out: '0.0005',
      min_amount_out: '0.0005',
      target_protocol: 'uniswap_v3',
      paper_trade: false,
      valuation_status: 'unpriced',
    }, 'Bot', 84532);

    expect(trade.chainId).toBe(84532);
    expect(trade.tokenIn).toBe('USDC');
    expect(trade.tokenOut).toBe('WETH');
    expect(trade.assetIn.name).toBe('USD Coin');
    expect(trade.assetOut.name).toBe('Wrapped Ether');
  });

  it('prefers persisted amount_out over simulation output and minimum output', () => {
    expect(deriveTradeAmountOut({
      amount_out: '3211',
      min_amount_out: '3200',
      validation: {
        simulation: {
          output_amount: '3210.5',
        },
      },
    })).toBe(3211);
  });

  it('marks failed paper simulations as failed instead of generic paper', () => {
    expect(getTradeStatus({
      paper_trade: true,
      validation: {
        approved: true,
        simulation: {
          success: false,
        },
      },
    })).toBe('failed');
  });

  it('maps persisted execution QA fields when present', () => {
    const trade = mapApiTrade({
      id: 'trade-4',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'buy',
      token_in: 'USDC',
      token_out: 'prediction-token',
      amount_in: '100',
      min_amount_out: '0',
      target_protocol: 'polymarket_clob',
      paper_trade: true,
      execution_status: 'paper',
      clob_order_id: 'order-123',
      requested_price_usd: '0.44',
      filled_price_usd: '0.45',
      filled_amount: '80',
      slippage_bps: '227.27',
      execution_reason: 'Would have partially filled against the live book.',
      valuation_status: 'unpriced',
    }, 'Bot');

    expect(trade.execution).toEqual({
      status: 'paper',
      clobOrderId: 'order-123',
      requestedPriceUsd: 0.44,
      filledPriceUsd: 0.45,
      filledAmount: 80,
      slippageBps: 227.27,
      reason: 'Would have partially filled against the live book.',
    });
  });

  it('maps persisted prediction metadata for human-readable trade history labels', () => {
    const trade = mapApiTrade({
      id: 'trade-5',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'buy',
      token_in: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      token_out: '48328953829',
      amount_in: '100',
      min_amount_out: '0',
      target_protocol: 'polymarket_clob',
      paper_trade: true,
      prediction_metadata: {
        condition_id: '0xcondition',
        token_id: '48328953829',
        market_question: 'Will ETH be above $4,000 on June 30?',
        outcome_label: 'YES',
        outcome_index: 0,
        market_slug: 'eth-above-4000-june-30',
      },
      valuation_status: 'unpriced',
    }, 'Bot');

    expect(trade.tokenIn).toBe('USDC');
    expect(trade.predictionMetadata).toEqual({
      conditionId: '0xcondition',
      tokenId: '48328953829',
      marketQuestion: 'Will ETH be above $4,000 on June 30?',
      outcomeLabel: 'YES',
      outcomeIndex: 0,
      marketSlug: 'eth-above-4000-june-30',
    });
  });

  it('maps persisted trade mechanism attribution', () => {
    const trade = mapApiTrade({
      id: 'trade-6',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'buy',
      token_in: 'USDC',
      token_out: 'WETH',
      amount_in: '100',
      min_amount_out: '0',
      target_protocol: 'uniswap_v3',
      paper_trade: true,
      valuation_status: 'unpriced',
      decision_source: 'code_strategy',
      runner_signal: { strategy_id: 'template-momentum-breakout' },
      agent_reasoning: 'breakout confirmed',
      harness_version: 3,
      candidate_hash: '0xcandidate',
      revision_id: 'rev-3',
    }, 'Bot');

    expect(trade.decisionSource).toBe('code_strategy');
    expect(trade.strategyModuleId).toBe('template-momentum-breakout');
    expect(trade.agentReasoning).toBe('breakout confirmed');
    expect(trade.harnessVersion).toBe(3);
    expect(trade.candidateHash).toBe('0xcandidate');
    expect(trade.revisionId).toBe('rev-3');
  });
});
