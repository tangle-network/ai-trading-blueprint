#!/usr/bin/env node
// Inspect live Aave reserve availability on the bot's execution RPC.
// Usage: node aave-reserve-status.js

const fs = require('fs');
const http = require('http');
const https = require('https');

const CONFIG_FILE = '/home/agent/config/api.json';
const GET_CONFIGURATION_SELECTOR = '0xc44b11f7';

const POOL_BY_CHAIN = {
  1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  10: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  137: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  8453: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  31339: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  43114: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

const DEFAULT_ASSETS = [
  {
    symbol: 'WETH',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  {
    symbol: 'USDC',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  {
    symbol: 'DAI',
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  },
];

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {
      rpc_url: process.env.RPC_URL || 'http://host.docker.internal:8545',
      chain_id: Number(process.env.CHAIN_ID || '1'),
    };
  }
}

function rpcCall(rpcUrl, method, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(rpcUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('RPC timeout'));
    });
    req.write(body);
    req.end();
  });
}

function encodeAddress(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function chunkWords(hex) {
  const normalized = hex.replace(/^0x/, '');
  const words = [];
  for (let i = 0; i < normalized.length; i += 64) {
    words.push(normalized.slice(i, i + 64));
  }
  return words;
}

function wordToBigInt(word) {
  return BigInt(`0x${word || '0'}`);
}

function wordToBool(word) {
  return wordToBigInt(word) !== 0n;
}

function decodeReserveConfiguration(hex) {
  const words = chunkWords(hex);
  if (words.length < 1 || !words[0]) {
    throw new Error(`Unexpected reserve config response length: ${words.length} words`);
  }

  const data = wordToBigInt(words[0]);
  const readBit = (bit) => ((data >> BigInt(bit)) & 1n) === 1n;
  const readRange = (start, length) =>
    Number((data >> BigInt(start)) & ((1n << BigInt(length)) - 1n));

  return {
    decimals: readRange(48, 8),
    ltv_bps: readRange(0, 16),
    liquidation_threshold_bps: readRange(16, 16),
    liquidation_bonus_bps: readRange(32, 16),
    reserve_factor_bps: readRange(64, 16),
    usage_as_collateral_enabled: readRange(16, 16) > 0,
    borrowing_enabled: readBit(58),
    stable_borrow_rate_enabled: readBit(59),
    is_active: readBit(56),
    is_frozen: readBit(57),
    is_paused: readBit(60),
    flash_loan_enabled: readBit(63),
  };
}

function summarizeAvailability(config) {
  if (!config.is_active) {
    return {
      available_for_supply: false,
      reason: 'reserve_inactive',
    };
  }
  if (config.is_frozen) {
    return {
      available_for_supply: false,
      reason: 'reserve_frozen',
    };
  }
  if (config.is_paused) {
    return {
      available_for_supply: false,
      reason: 'reserve_paused',
    };
  }
  return {
    available_for_supply: true,
    reason: 'available',
  };
}

async function fetchReserveStatus(rpcUrl, chainId, asset) {
  const pool = POOL_BY_CHAIN[chainId];
  if (!pool) {
    return {
      ...asset,
      error: `unsupported_chain_${chainId}`,
      available_for_supply: false,
      reason: 'unsupported_chain',
    };
  }

  const data = `${GET_CONFIGURATION_SELECTOR}${encodeAddress(asset.address)}`;
  const result = await rpcCall(rpcUrl, 'eth_call', [
    {
      to: pool,
      data,
    },
    'latest',
  ]);

  const decoded = decodeReserveConfiguration(result);
  const availability = summarizeAvailability(decoded);

  return {
    ...asset,
    ...decoded,
    ...availability,
  };
}

async function main() {
  const config = loadConfig();
  const rpcUrl = config.rpc_url || process.env.RPC_URL || 'http://host.docker.internal:8545';
  const chainId = Number(config.chain_id || process.env.CHAIN_ID || '1');

  const assets = [];
  for (const asset of DEFAULT_ASSETS) {
    try {
      assets.push(await fetchReserveStatus(rpcUrl, chainId, asset));
    } catch (error) {
      assets.push({
        ...asset,
        error: error.message,
        available_for_supply: false,
        reason: 'rpc_error',
      });
    }
  }

  const executable = assets
    .filter((asset) => asset.available_for_supply)
    .map((asset) => asset.symbol);

  const blocked = assets
    .filter((asset) => !asset.available_for_supply)
    .map((asset) => ({
      symbol: asset.symbol,
      reason: asset.reason,
    }));

  console.log(
    JSON.stringify(
      {
        protocol: 'aave_v3',
        chain_id: chainId,
        rpc_url: rpcUrl,
        pool: POOL_BY_CHAIN[chainId] || null,
        executable_supply_assets: executable,
        blocked_supply_assets: blocked,
        preferred_supply_asset: executable.includes('USDC')
          ? 'USDC'
          : executable[0] || null,
        assets,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: error.message,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
