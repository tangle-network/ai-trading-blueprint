# Generated Strategies

Write generated strategies as small CommonJS modules in `/home/agent/tools/strategies/`.
Start from `/home/agent/tools/strategies/templates/` when the user intent matches one of the included patterns:

- `market-maker.js` for spread capture with inventory skew.
- `momentum-breakout.js` for bounded trend-following swaps.
- `mean-reversion.js` for z-score dip/rip signals.
- `portfolio-rebalance.js` for target-weight drift control.
- `risk-off-guard.js` for drawdown, volatility, and loss-streak cooldown logic.

```js
module.exports = {
  id: 'example-strategy',
  async tick(ctx) {
    const portfolio = await ctx.getPortfolio()
    const prices = await ctx.getPrices(['WETH', 'USDC'])

    if (!prices.data) return ctx.skip('price unavailable')

    return ctx.submitTrade({
      action: 'swap',
      token_in: 'USDC',
      token_out: 'WETH',
      amount_in: '500000000',
      min_amount_out: '0',
      reason: 'example signal',
    })
  },
}
```

Run one tick:

```sh
node /home/agent/tools/run-strategy.js /home/agent/tools/strategies/example-strategy.js
```

`ctx.submitTrade()` owns the safety path: circuit breaker, intent normalization, validator/API validation, paper/live gate, execution, and JSONL logging. Strategy code should focus on signals and return `ctx.skip(reason)` when there is no safe trade.

Useful `ctx` helpers:

- `getPortfolio()`
- `getPrices(tokens)`
- `getSupportedAssets()`
- `quoteUniswapSwap(args)`
- `recommendSlippageBps(args)`
- `submitTrade(intent)`
- `logDecision(entry)`
- `writeArtifact(name, value)`
- `skip(reason, extra)`

Default mode is paper. Live execution only happens when the bot is explicitly live-enabled and validation approves the trade. Do not load private keys or submit transactions directly from a strategy.
