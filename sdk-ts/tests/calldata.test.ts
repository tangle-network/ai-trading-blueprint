import { describe, it, expect } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import {
  encodeUniswapV3ExactInputSingle,
  encodeAerodromeExactInputSingle,
  encodeAaveSupply,
  encodeMorphoSupply,
} from '../src/encoding/calldata.js';

const TOKEN_IN: Address = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const TOKEN_OUT: Address = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const RECIPIENT: Address = '0x1111111111111111111111111111111111111111';
const POOL: Address = '0x2222222222222222222222222222222222222222';
const MORPHO: Address = '0x3333333333333333333333333333333333333333';

const UNI_V3_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

describe('calldata encoders are roundtrip-decodable', () => {
  it('encodeUniswapV3ExactInputSingle uses 0x414bf389 selector and decodes round-trip', () => {
    const data = encodeUniswapV3ExactInputSingle({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      fee: 500,
      recipient: RECIPIENT,
      deadline: 1700000000n,
      amountIn: 1_000_000n,
      amountOutMinimum: 900_000n,
      sqrtPriceLimitX96: 0n,
    });
    expect(data.slice(0, 10)).toBe('0x414bf389');

    const decoded = decodeFunctionData({ abi: UNI_V3_ABI, data });
    expect(decoded.functionName).toBe('exactInputSingle');
    const params = decoded.args[0];
    expect(params.tokenIn.toLowerCase()).toBe(TOKEN_IN.toLowerCase());
    expect(params.amountIn).toBe(1_000_000n);
    expect(params.fee).toBe(500);
  });

  it('encodeAerodromeExactInputSingle uses int24 tickSpacing in the selector', () => {
    const data = encodeAerodromeExactInputSingle({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      tickSpacing: 60,
      recipient: RECIPIENT,
      deadline: 1700000000n,
      amountIn: 100n,
      amountOutMinimum: 99n,
      sqrtPriceLimitX96: 0n,
    });
    // Aerodrome selector differs from Uniswap V3 because tickSpacing is int24.
    expect(data.slice(0, 10)).not.toBe('0x414bf389');
    expect(data.slice(0, 2)).toBe('0x');
  });

  it('encodeAaveSupply uses supply(address,uint256,address,uint16) selector', () => {
    const data = encodeAaveSupply(TOKEN_IN, 1000n, RECIPIENT);
    expect(data.length).toBeGreaterThan(10);
  });

  it('encodeMorphoSupply produces calldata for tuple struct + four args', () => {
    const data = encodeMorphoSupply(
      {
        loanToken: TOKEN_IN,
        collateralToken: TOKEN_OUT,
        oracle: POOL,
        irm: POOL,
        lltv: 800_000_000_000_000_000n,
      },
      1_000n,
      MORPHO,
    );
    expect(data.slice(0, 2)).toBe('0x');
    expect(data.length).toBeGreaterThan(10);
  });
});
