import { addTx, updateTx } from '@tangle-network/blueprint-ui';
import type { Trade } from '~/lib/types/trade';

function toBigInt(value: number | string | undefined): bigint | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return BigInt(Math.trunc(value));
  }
  if (value.trim() === '') return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function buildTradeLabel(trade: Trade): string {
  const action = trade.action === 'buy' ? 'Buy' : 'Sell';
  return `${action} ${trade.tokenIn} -> ${trade.tokenOut}`;
}

export function syncTradesIntoTxStore(trades: Trade[], fallbackChainId: number) {
  for (const trade of trades) {
    if (!trade.txHash || !trade.txHash.startsWith('0x')) continue;

    const chainId = trade.chainId ?? fallbackChainId;
    addTx(trade.txHash as `0x${string}`, buildTradeLabel(trade), chainId);

    if (trade.status === 'executed') {
      updateTx(trade.txHash as `0x${string}`, {
        status: 'confirmed',
        blockNumber: toBigInt(trade.blockNumber),
        gasUsed: toBigInt(trade.gasUsed),
      });
    } else if (trade.status === 'failed' || trade.status === 'rejected') {
      updateTx(trade.txHash as `0x${string}`, { status: 'failed' });
    }
  }
}
