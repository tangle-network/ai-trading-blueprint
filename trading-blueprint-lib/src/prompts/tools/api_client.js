// Trading API client module — shared by all tools
// Reads config from /home/agent/config/api.json (written during activation)
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

let _config = null;

function loadConfig() {
  if (_config) return _config;
  try {
    _config = JSON.parse(fs.readFileSync('/home/agent/config/api.json', 'utf8'));
  } catch {
    _config = {
      api_url: process.env.TRADING_API_URL || 'http://localhost:9100',
      token: process.env.TRADING_API_TOKEN || '',
    };
  }
  return _config;
}

function apiCall(method, path, body) {
  const config = loadConfig();
  const url = new URL(path, config.api_url);
  const proto = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Bearer ' + config.token,
        'Content-Type': 'application/json',
      },
    };
    const req = proto.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function validate(intent) {
  return apiCall('POST', '/validate', intent);
}

async function execute(intent, validation) {
  return apiCall('POST', '/execute', { intent, validation });
}

async function checkCircuitBreaker(maxDrawdownPct) {
  return apiCall('POST', '/circuit-breaker/check', {
    max_drawdown_pct: maxDrawdownPct || 10.0,
  });
}

async function getPortfolio() {
  return apiCall('POST', '/portfolio/state', {});
}

async function getPrices(tokens) {
  return apiCall('POST', '/market-data/prices', { tokens });
}

async function getAdapters() {
  return apiCall('GET', '/adapters');
}

async function getMetrics() {
  return apiCall('GET', '/metrics');
}

module.exports = {
  loadConfig,
  apiCall,
  validate,
  execute,
  checkCircuitBreaker,
  getPortfolio,
  getPrices,
  getAdapters,
  getMetrics,
};
