import { describe, expect, it } from 'vitest';
import { summarizeBotLiveData } from './useBotLiveSummary';

describe('summarizeBotLiveData', () => {
  it('derives live summary values from metrics, portfolio, and trades', () => {
    const summary = summarizeBotLiveData(
      [
        {
          account_value_usd: 10000,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          trade_count: 0,
        },
        {
          account_value_usd: 10100,
          realized_pnl: 25,
          unrealized_pnl: 75,
          drawdown_pct: 1.1,
          trade_count: 1,
        },
        {
          account_value_usd: 10050,
          realized_pnl: 25,
          unrealized_pnl: 25,
          drawdown_pct: 2.4,
          trade_count: 2,
        },
        {
          account_value_usd: 10200,
          realized_pnl: 40,
          unrealized_pnl: 160,
          drawdown_pct: 1.3,
          trade_count: 3,
        },
      ],
      10200,
      [80, undefined, 100],
      'priced',
    );

    expect(summary.pnlPercent).toBe(2);
    expect(summary.pnlAbsolute).toBe(200);
    expect(summary.maxDrawdown).toBe(2.4);
    expect(summary.portfolioValue).toBe(10200);
    expect(summary.avgValidatorScore).toBe(90);
    expect(summary.sharpeRatio).not.toBeNull();
    expect(summary.winRate).toBe(66.7);
  });

  it('returns nulls for unsupported or insufficient live data', () => {
    const summary = summarizeBotLiveData(
      [
        {
          account_value_usd: 10000,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          trade_count: 0,
        },
        {
          account_value_usd: 10000,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          trade_count: 0,
        },
      ],
      null,
      [],
      'missing',
    );

    expect(summary.pnlPercent).toBe(0);
    expect(summary.pnlAbsolute).toBe(0);
    expect(summary.sharpeRatio).toBeNull();
    expect(summary.maxDrawdown).toBe(0);
    expect(summary.portfolioValue).toBe(10000);
    expect(summary.avgValidatorScore).toBeNull();
    expect(summary.winRate).toBeNull();
  });

  it('falls back to the latest account value when portfolio data is missing', () => {
    const summary = summarizeBotLiveData(
      [
        {
          account_value_usd: 10000,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          trade_count: 0,
        },
        {
          account_value_usd: 10167.04,
          realized_pnl: 40,
          unrealized_pnl: 127.04,
          drawdown_pct: 0.5,
          trade_count: 1,
        },
      ],
      0,
      [100],
      'missing',
    );

    expect(summary.portfolioValue).toBe(10167.04);
  });

  it('returns null when the current portfolio is explicitly unpriced', () => {
    const summary = summarizeBotLiveData(
      [
        {
          account_value_usd: 10167.04,
          realized_pnl: 40,
          unrealized_pnl: 127.04,
          drawdown_pct: 0.5,
          trade_count: 1,
        },
      ],
      null,
      [],
      'unpriced',
    );

    expect(summary.portfolioValue).toBeNull();
  });

  it('keeps portfolio value visible when the current portfolio is value-only', () => {
    const summary = summarizeBotLiveData(
      [
        {
          account_value_usd: 10167.04,
          realized_pnl: 40,
          unrealized_pnl: 127.04,
          drawdown_pct: 0.5,
          trade_count: 1,
        },
      ],
      4200,
      [],
      'value_only',
    );

    expect(summary.portfolioValue).toBe(4200);
  });

  it('preserves a priced zero portfolio value', () => {
    const summary = summarizeBotLiveData(
      [
        {
          account_value_usd: 10167.04,
          realized_pnl: 40,
          unrealized_pnl: 127.04,
          drawdown_pct: 0.5,
          trade_count: 1,
        },
      ],
      0,
      [],
      'priced',
    );

    expect(summary.portfolioValue).toBe(0);
  });

  it('ignores leading zero-value snapshots when valid history exists later', () => {
    const summary = summarizeBotLiveData(
      [
        {
          account_value_usd: 0,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          trade_count: 0,
        },
        {
          account_value_usd: 0,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          trade_count: 0,
        },
        {
          account_value_usd: 2212.61,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          trade_count: 13,
        },
        {
          account_value_usd: 2243.47,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          trade_count: 17,
        },
      ],
      null,
      [100],
      'unpriced',
    );

    expect(summary.pnlPercent).toBe(1.4);
    expect(summary.maxDrawdown).toBe(0);
    expect(summary.portfolioValue).toBeNull();
    expect(summary.winRate).toBe(100);
  });
});
