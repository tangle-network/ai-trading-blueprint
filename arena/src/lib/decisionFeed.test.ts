import { describe, expect, it } from 'vitest';
import {
  buildDecisionItemFromRun,
  buildDecisionItemFromTrade,
  buildRunResultSections,
  getRunSignalLabel,
  parseRunResultJson,
} from './decisionFeed';
import type { BotRun } from './botRuns';
import type { Trade } from './types/trade';
import type { ResolvedAssetDisplay } from './tradeTokenMetadata';

function asset(symbol: string): ResolvedAssetDisplay {
  return {
    rawToken: symbol,
    symbol,
    name: symbol,
    primaryLabel: symbol,
    isKnown: true,
    accentClassName: 'bg-slate-500/10 text-slate-700',
    iconText: symbol.slice(0, 2),
  };
}

describe('decisionFeed', () => {
  it('normalizes trading run JSON into an auditable decision item', () => {
    const run: BotRun = {
      runId: 'run-json',
      workflowId: 101,
      workflowKind: 'trading',
      status: 'completed',
      startedAt: 1_775_849_924,
      completedAt: 1_775_850_048,
      sessionId: 'direct-hyperliquid-fast-bot-1',
      transcriptAvailable: false,
      traceId: 'trace-1',
      durationMs: 128_000,
      inputTokens: 100,
      outputTokens: 40,
      result: JSON.stringify({
        checked_state: {
          nav_status: 'fresh',
          protocol: 'hyperliquid',
          total_nav_usdc: 11,
        },
        decision: {
          action: 'trade',
          reason: 'rsi-oversold',
          setup: {
            action: 'open_long',
            asset: 'ETH',
            amount_in: '11',
          },
        },
        trade_action: {
          attempted: true,
          validation_status: 'approved',
          execution_status: 'filled',
          notional_usd: '11',
          target_protocol: 'hyperliquid',
        },
      }),
      error: null,
    };

    const item = buildDecisionItemFromRun(run);

    expect(getRunSignalLabel(run)).toBe('TRADE');
    expect(item.id).toBe('run:run-json');
    expect(item.actionLabel).toBe('TRADE');
    expect(item.instrumentLabel).toBe('ETH');
    expect(item.reason).toBe('rsi-oversold');
    expect(item.notionalLabel).toBe('$11');
    expect(item.validationLabel).toBe('approved');
    expect(item.executionLabel).toBe('filled');
    expect(item.stages.map((stage) => [stage.key, stage.value, stage.tone])).toEqual([
      ['state', 'fresh', 'success'],
      ['decision', 'trade', 'neutral'],
      ['validation', 'approved', 'success'],
      ['execution', 'filled', 'success'],
    ]);

    const parsed = parseRunResultJson(run.result);
    expect(parsed).not.toBeNull();
    expect(buildRunResultSections(parsed ?? {}).map((section) => section.title)).toEqual([
      'Checked State',
      'Decision',
      'Trade',
    ]);
  });

  it('normalizes trade metadata into decision provenance', () => {
    const trade = {
      id: 'trade-1',
      botId: 'bot-1',
      botName: 'Trend Runner',
      action: 'open_long',
      assetIn: asset('USDC'),
      assetOut: asset('ETH'),
      tokenIn: 'USDC',
      tokenOut: 'ETH',
      amountIn: 25,
      amountOut: 0.01,
      priceUsd: 2500,
      notionalUsd: 25,
      timestamp: 1_775_849_924_000,
      status: 'executed',
      targetProtocol: 'hyperliquid',
      venue: 'perp',
      validatorScore: 0.92,
      validatorReasoning: 'risk within cap',
      validation: {
        approved: true,
        aggregateScore: 0.92,
        intentHash: 'intent-1',
        responses: [
          {
            validator: 'risk',
            score: 0.92,
            reasoning: 'risk within cap',
            signature: 'sig',
          },
        ],
      },
      execution: {
        status: 'filled',
        filledPriceUsd: 2501,
        slippageBps: 4,
      },
      decisionSource: 'code_strategy',
      strategyModuleId: 'momentum-v1',
      revisionId: 'rev-1',
      candidateHash: 'candidate-1',
      agentReasoning: 'breakout confirmed',
      harnessVersion: 3,
    } as Trade;

    const item = buildDecisionItemFromTrade(trade);

    expect(item.title).toBe('OPEN LONG / USDC/ETH');
    expect(item.statusTone).toBe('success');
    expect(item.reason).toBe('breakout confirmed');
    expect(item.notionalLabel).toBe('$25');
    expect(item.validationLabel).toBe('Approved 0.92');
    expect(item.executionLabel).toBe('filled');
    expect(item.provenance).toEqual(
      expect.arrayContaining([
        { label: 'Strategy', value: 'momentum-v1' },
        { label: 'Revision', value: 'rev-1' },
        { label: 'Harness', value: '3' },
      ]),
    );
  });

  it('uses plain saved run results as the decision reason when JSON is absent', () => {
    const run: BotRun = {
      runId: 'run-plain',
      workflowId: 102,
      workflowKind: 'trading',
      status: 'completed',
      startedAt: 1_775_849_924,
      completedAt: 1_775_850_048,
      sessionId: null,
      transcriptAvailable: false,
      traceId: null,
      durationMs: 60_000,
      inputTokens: 10,
      outputTokens: 6,
      result: 'Placed a bounded ETH breakout probe after fast replay and liquidity check.',
      error: null,
    };

    expect(buildDecisionItemFromRun(run).reason).toBe(
      'Placed a bounded ETH breakout probe after fast replay and liquidity check.',
    );
  });
});
