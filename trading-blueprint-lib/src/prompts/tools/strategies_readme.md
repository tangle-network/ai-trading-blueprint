# Generated Strategies

Write generated strategies as small CommonJS modules in `/home/agent/tools/strategies/`.

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
