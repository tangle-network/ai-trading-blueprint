#!/usr/bin/env node
/**
 * Sweep different field values to find what the pricing engine actually signed.
 */
import { keccak256, encodeAbiParameters, parseAbiParameters, recoverAddress, toBytes, encodePacked } from 'viem';

const TANGLE = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const OPERATOR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// Domain
const DOMAIN_SEP = keccak256(encodeAbiParameters(
  parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
  [
    keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak256(toBytes("TangleQuote")),
    keccak256(toBytes("1")),
    31337n,
    TANGLE,
  ]
));

const QUOTE_TH = keccak256(toBytes("QuoteDetails(uint64 blueprintId,uint64 ttlBlocks,uint256 totalCost,uint64 timestamp,uint64 expiry,AssetSecurityCommitment[] securityCommitments)AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));
const COMMIT_TH = keccak256(toBytes("AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));
const ASSET_TH = keccak256(toBytes("Asset(uint8 kind,address token)"));

function computeDigest(bp, ttl, cost, ts, exp, assetKind, token, bps) {
  const ah = keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint8, address'), [ASSET_TH, assetKind, token]));
  const ch = keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint16'), [COMMIT_TH, ah, bps]));
  const arrH = keccak256(ch);
  const qh = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
    [QUOTE_TH, bp, ttl, cost, ts, exp, arrH]
  ));
  return keccak256(encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', DOMAIN_SEP, qh]));
}

async function tryRecover(digest, sigHex) {
  for (const v of [27, 28]) {
    const sig65 = `0x${sigHex}${v.toString(16).padStart(2, '0')}`;
    try {
      const recovered = await recoverAddress({ hash: digest, signature: sig65 });
      if (recovered.toLowerCase() === OPERATOR1.toLowerCase()) return v;
    } catch {}
  }
  return 0;
}

async function main() {
  // Fetch a real quote
  const { createClient } = await import('@connectrpc/connect');
  const { createGrpcWebTransport } = await import('@connectrpc/connect-web');
  const { PricingEngine } = await import('../src/lib/gen/pricing_pb.ts');
  const { sha256 } = await import('viem');

  const blueprintId = 0n;
  const ttlBlocks = BigInt(Math.floor((30 * 86400) / 12));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  // Quick PoW
  const input = new Uint8Array(16);
  const v = new DataView(input.buffer);
  v.setBigUint64(0, blueprintId, false);
  v.setBigUint64(8, timestamp, false);
  const challenge = sha256(input, 'bytes');
  const buf = new Uint8Array(challenge.length + 8);
  buf.set(challenge, 0);
  const dv = new DataView(buf.buffer);
  let pow;
  for (let n = 0; n < 0x1_0000_0000; n++) {
    dv.setBigUint64(challenge.length, BigInt(n), false);
    const h = sha256(buf, 'bytes');
    if (h[0] === 0 && h[1] === 0 && (h[2] & 0xF0) === 0) {
      pow = new Uint8Array(48);
      const pv = new DataView(pow.buffer);
      pv.setBigUint64(0, 32n, true);
      pow.set(h, 8);
      pv.setBigUint64(40, BigInt(n), true);
      break;
    }
  }

  const transport = createGrpcWebTransport({ baseUrl: 'http://127.0.0.1:50051' });
  const client = createClient(PricingEngine, transport);
  const resp = await client.getPrice({
    blueprintId, ttlBlocks, proofOfWork: pow, challengeTimestamp: timestamp,
    resourceRequirements: [
      { kind: 'CPU', count: 1n },
      { kind: 'MemoryMB', count: 1024n },
      { kind: 'StorageMB', count: 10240n },
    ],
    securityRequirements: {
      asset: { assetType: { case: 'erc20', value: new Uint8Array(20) } },
      minimumExposurePercent: 10, maximumExposurePercent: 100,
    },
  });

  const d = resp.quoteDetails;
  const sigHex = Array.from(resp.signature).map(b => b.toString(16).padStart(2, '0')).join('');
  const baseCost = BigInt(Math.floor(d.totalCostRate * 1e9));

  const sc = d.securityCommitments[0];
  console.log(`Proto fields:`);
  console.log(`  blueprintId: ${d.blueprintId}`);
  console.log(`  ttlBlocks: ${d.ttlBlocks}`);
  console.log(`  totalCostRate: ${d.totalCostRate}`);
  console.log(`  timestamp: ${d.timestamp}`);
  console.log(`  expiry: ${d.expiry}`);
  console.log(`  exposure_percent: ${sc.exposurePercent}`);
  console.log(`  asset case: ${sc.asset?.assetType?.case}`);
  console.log(`  asset value (hex): ${sc.asset?.assetType?.value ? Array.from(sc.asset.assetType.value).map(b => b.toString(16).padStart(2, '0')).join('') : 'null'}`);
  console.log(`  baseCost (f64*1e9): ${baseCost}`);
  console.log(`  sig length: ${resp.signature.length} bytes`);

  const ZERO = '0x0000000000000000000000000000000000000000';

  // ── Sweep 1: Try different exposureBps ──
  console.log('\n--- Sweep: exposureBps ---');
  for (const bps of [10, 100, 1000, 5000, 10000, sc.exposurePercent]) {
    const d2 = computeDigest(d.blueprintId, d.ttlBlocks, baseCost, d.timestamp, d.expiry, 1, ZERO, bps);
    const found = await tryRecover(d2, sigHex);
    if (found) console.log(`  ✅ exposureBps=${bps} v=${found}`);
    else console.log(`  ❌ exposureBps=${bps}`);
  }

  // ── Sweep 2: Try different asset kinds ──
  console.log('\n--- Sweep: assetKind ---');
  for (const kind of [0, 1, 2]) {
    const d2 = computeDigest(d.blueprintId, d.ttlBlocks, baseCost, d.timestamp, d.expiry, kind, ZERO, sc.exposurePercent * 100);
    const found = await tryRecover(d2, sigHex);
    if (found) console.log(`  ✅ kind=${kind} v=${found}`);
    else console.log(`  ❌ kind=${kind}`);
  }

  // ── Sweep 3: empty commitments ──
  console.log('\n--- Sweep: empty commitments ---');
  {
    const emptyArrH = keccak256('0x');
    const qh = keccak256(encodeAbiParameters(
      parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
      [QUOTE_TH, d.blueprintId, d.ttlBlocks, baseCost, d.timestamp, d.expiry, emptyArrH]
    ));
    const d2 = keccak256(encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', DOMAIN_SEP, qh]));
    const found = await tryRecover(d2, sigHex);
    if (found) console.log(`  ✅ empty commitments v=${found}`);
    else console.log(`  ❌ empty commitments`);
  }

  // ── Sweep 4: Try many exposureBps with kind=1, cost sweep ──
  console.log('\n--- Sweep: combined cost + bps ---');
  for (const bps of [1000, 10000]) {
    for (let offset = -5n; offset <= 5n; offset++) {
      const cost = baseCost + offset;
      const d2 = computeDigest(d.blueprintId, d.ttlBlocks, cost, d.timestamp, d.expiry, 1, ZERO, bps);
      const found = await tryRecover(d2, sigHex);
      if (found) {
        console.log(`  ✅ cost=${cost} bps=${bps} v=${found}`);
        return;
      }
    }
  }
  console.log('  ❌ no match');

  // ── Sweep 5: Try with exposureBps = raw exposurePercent (no *100) ──
  console.log('\n--- Sweep: exposureBps = raw exposurePercent (no *100) ---');
  const d2 = computeDigest(d.blueprintId, d.ttlBlocks, baseCost, d.timestamp, d.expiry, 1, ZERO, sc.exposurePercent);
  const found = await tryRecover(d2, sigHex);
  if (found) console.log(`  ✅ exposureBps=${sc.exposurePercent} (raw) v=${found}`);
  else console.log(`  ❌ exposureBps=${sc.exposurePercent} (raw)`);
}

main().catch(console.error);
