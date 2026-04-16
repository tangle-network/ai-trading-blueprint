// Record candle data for backtesting
// Appends OHLCV candles to /home/agent/data/candles.json
// The agent should call this after fetching prices to build history
//
// Usage:
//   node record-candle.js '{"open":100,"high":102,"low":99,"close":101,"volume":50000}'
//   node record-candle.js '{"candles":[{...},{...}]}'  (batch mode)
//   node record-candle.js stats  (show candle statistics)

const fs = require('fs');

const CANDLE_PATH = '/home/agent/data/candles.json';
const MAX_CANDLES = 10000;

function loadCandles() {
  try {
    return JSON.parse(fs.readFileSync(CANDLE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveCandles(candles) {
  fs.mkdirSync('/home/agent/data', { recursive: true });
  // Keep only the most recent MAX_CANDLES
  const trimmed = candles.slice(-MAX_CANDLES);
  fs.writeFileSync(CANDLE_PATH, JSON.stringify(trimmed));
}

function main() {
  const arg = process.argv[2];

  if (arg === 'stats') {
    const candles = loadCandles();
    const result = {
      total: candles.length,
      oldest: candles.length > 0 ? new Date(candles[0].timestamp * 1000).toISOString() : null,
      newest: candles.length > 0 ? new Date(candles[candles.length - 1].timestamp * 1000).toISOString() : null,
      hours_of_data: candles.length > 1
        ? ((candles[candles.length - 1].timestamp - candles[0].timestamp) / 3600).toFixed(1)
        : 0,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const input = JSON.parse(arg);
  const candles = loadCandles();

  if (input.candles) {
    // Batch mode
    for (const c of input.candles) {
      c.timestamp = c.timestamp || Math.floor(Date.now() / 1000);
      candles.push(c);
    }
  } else {
    // Single candle
    input.timestamp = input.timestamp || Math.floor(Date.now() / 1000);
    candles.push(input);
  }

  saveCandles(candles);
  console.log(JSON.stringify({ recorded: input.candles ? input.candles.length : 1, total: Math.min(candles.length, MAX_CANDLES) }));
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
