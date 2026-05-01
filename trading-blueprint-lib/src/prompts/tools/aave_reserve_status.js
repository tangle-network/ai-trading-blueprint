#!/usr/bin/env node
// Inspect live Aave reserve availability on the bot's execution RPC.
// Usage: node aave-reserve-status.js

const fs = require('fs');
const http = require('http');
const https = require('https');

const CONFIG_FILE = '/home/agent/config/api.json';
const GET_CONFIGURATION_SELECTOR = '0xc44b11f7';
const GET_RESERVE_DATA_SELECTOR = '0x35ea6a75';

const MARKET_ALIASES = {
  31338: 1,
  31339: 1,
};

const MARKETS = {
  1: {
    name: 'Ethereum mainnet',
    pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    protocol_data_provider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD',
    assets: [
      ['WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
      ['USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
      ['USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7'],
      ['DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F'],
      ['WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'],
    ],
  },
  8453: {
    name: 'Base',
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    protocol_data_provider: '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A',
    assets: [
      ['WETH', '0x4200000000000000000000000000000000000006'],
      ['USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      ['USDbC', '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA'],
      ['cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'],
    ],
  },
  42161: {
    name: 'Arbitrum',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol_data_provider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
    assets: [
      ['WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'],
      ['USDC', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'],
      ['USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'],
      ['DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'],
      ['WBTC', '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'],
    ],
  },
  137: {
    name: 'Polygon',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol_data_provider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
    assets: [
      ['WETH', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'],
      ['USDC', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'],
      ['DAI', '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'],
      ['WBTC', '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6'],
    ],
  },
  10: {
    name: 'Optimism',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol_data_provider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
    assets: [
      ['WETH', '0x4200000000000000000000000000000000000006'],
      ['USDC', '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'],
      ['USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'],
      ['DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'],
      ['WBTC', '0x68f180fcCe6836688e9084f035309E29Bf0A2095'],
    ],
  },
  43114: {
    name: 'Avalanche',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    protocol_data_provider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
    assets: [
      ['WAVAX', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'],
      ['USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'],
      ['USDt', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'],
      ['DAIe', '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70'],
      ['WETHe', '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB'],
      ['WBTCe', '0x50b7545627a5162F82A992c33b87aDc75187B218'],
    ],
  },
};

function resolveMarket(chainId) {
  const canonicalChainId = MARKET_ALIASES[chainId] || chainId;
  const market = MARKETS[canonicalChainId];
  return market ? { ...market, canonical_chain_id: canonicalChainId } : null;
}

function marketAssets(market) {
  return market.assets.map(([symbol, address]) => ({ symbol, address }));
}

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

function parsePositiveNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function resolveProtocolChainId(config) {
  return parsePositiveNumber(
    config.strategy_config && config.strategy_config.protocol_chain_id,
    config.protocol_chain_id,
    process.env.PROTOCOL_CHAIN_ID,
    process.env.FORK_BASE_CHAIN_ID,
    config.chain_id,
    process.env.CHAIN_ID,
    1,
  );
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

function wordToAddress(word) {
  const normalized = (word || '').padStart(64, '0');
  return `0x${normalized.slice(24)}`;
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
  const market = resolveMarket(chainId);
  if (!market) {
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
      to: market.pool,
      data,
    },
    'latest',
  ]);
  const reserveDataResult = await rpcCall(rpcUrl, 'eth_call', [
    {
      to: market.pool,
      data: `${GET_RESERVE_DATA_SELECTOR}${encodeAddress(asset.address)}`,
    },
    'latest',
  ]);

  const decoded = decodeReserveConfiguration(result);
  const reserveWords = chunkWords(reserveDataResult);
  const availability = summarizeAvailability(decoded);

  return {
    ...asset,
    chain_id: market.canonical_chain_id,
    ...decoded,
    a_token_address: wordToAddress(reserveWords[8]),
    stable_debt_token_address: wordToAddress(reserveWords[9]),
    variable_debt_token_address: wordToAddress(reserveWords[10]),
    ...availability,
  };
}

async function main() {
  const config = loadConfig();
  const rpcUrl = config.rpc_url || process.env.RPC_URL || 'http://host.docker.internal:8545';
  const chainId = Number(config.chain_id || process.env.CHAIN_ID || '1');
  const protocolChainId = resolveProtocolChainId(config);
  const market = resolveMarket(protocolChainId);

  if (!market) {
    console.log(
      JSON.stringify(
        {
          protocol: 'aave_v3',
          chain_id: chainId,
          protocol_chain_id: protocolChainId,
          rpc_url: rpcUrl,
          pool: null,
          executable_supply_assets: [],
          blocked_supply_assets: [],
          assets: [],
          error: `unsupported_chain_${protocolChainId}`,
          supported_protocol_chain_ids: Object.keys(MARKETS).map(Number),
        },
        null,
        2,
      ),
    );
    return;
  }

  const assets = [];
  for (const asset of marketAssets(market)) {
    try {
      assets.push(await fetchReserveStatus(rpcUrl, protocolChainId, asset));
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
        protocol_chain_id: protocolChainId,
        rpc_url: rpcUrl,
        market: market ? market.name : null,
        pool: market ? market.pool : null,
        protocol_data_provider: market ? market.protocol_data_provider : null,
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
