#!/usr/bin/env node
/**
 * Brute-force the correct totalCost by trying values near the f64-derived value.
 * Uses the MANUAL EIP-712 computation (matching Solidity) to recover the operator.
 */
import { keccak256, encodeAbiParameters, parseAbiParameters, recoverAddress, toBytes, encodePacked } from 'viem';

const TANGLE = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const CHAIN_ID = 31337;
const OPERATOR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// TypeHashes and domain (from Solidity verification)
const DOMAIN_SEP = keccak256(encodeAbiParameters(
  parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
  [
    keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak256(toBytes("TangleQuote")),
    keccak256(toBytes("1")),
    BigInt(CHAIN_ID),
    TANGLE,
  ]
));

const QUOTE_TYPEHASH = keccak256(toBytes("QuoteDetails(uint64 blueprintId,uint64 ttlBlocks,uint256 totalCost,uint64 timestamp,uint64 expiry,AssetSecurityCommitment[] securityCommitments)AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));
const COMMITMENT_TYPEHASH = keccak256(toBytes("AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));
const ASSET_TYPEHASH = keccak256(toBytes("Asset(uint8 kind,address token)"));

function computeDigest(blueprintId, ttlBlocks, totalCost, timestamp, expiry, assetKind, assetToken, exposureBps) {
  const assetHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint8, address'), [ASSET_TYPEHASH, assetKind, assetToken]
  ));
  const commitmentHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, uint16'), [COMMITMENT_TYPEHASH, assetHash, exposureBps]
  ));
  const commitmentsArrayHash = keccak256(commitmentHash);
  const quoteHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
    [QUOTE_TYPEHASH, blueprintId, ttlBlocks, totalCost, timestamp, expiry, commitmentsArrayHash]
  ));
  return keccak256(encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', DOMAIN_SEP, quoteHash]));
}

async function main() {
  const { createClient } = await import('@connectrpc/connect');
  const { createGrpcWebTransport } = await import('@connectrpc/connect-web');
  const { PricingEngine } = await import('../src/lib/gen/pricing_pb.ts');
  const { sha256 } = await import('viem');

  // Fetch a real quote
  const blueprintId = 0n;
  const ttlBlocks = BigInt(Math.floor((30 * 86400) / 12));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  function solvePoW(bid, ts) {
    const input = new Uint8Array(16);
    const v = new DataView(input.buffer);
    v.setBigUint64(0, bid, false);
    v.setBigUint64(8, ts, false);
    const challenge = sha256(input, 'bytes');
    const buf = new Uint8Array(challenge.length + 8);
    buf.set(challenge, 0);
    const dv = new DataView(buf.buffer);
    for (let nonce = 0; nonce < 0x1_0000_0000; nonce++) {
      dv.setBigUint64(challenge.length, BigInt(nonce), false);
      const hash = sha256(buf, 'bytes');
      const zB = 2; // 20 bits = 2.5 bytes
      if (hash[0] === 0 && hash[1] === 0 && (hash[2] & 0xF0) === 0) {
        const proof = new Uint8Array(48);
        const pv = new DataView(proof.buffer);
        pv.setBigUint64(0, 32n, true);
        proof.set(hash, 8);
        pv.setBigUint64(40, BigInt(nonce), true);
        return proof;
      }
    }
    throw new Error('PoW exhausted');
  }

  console.log('Fetching quote...');
  const transport = createGrpcWebTransport({ baseUrl: 'http://127.0.0.1:50051' });
  const client = createClient(PricingEngine, transport);
  const pow = solvePoW(blueprintId, timestamp);

  const response = await client.getPrice({
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

  const d = response.quoteDetails;
  const sig = response.signature;
  const sigHex = Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('');

  console.log(`totalCostRate: ${d.totalCostRate}`);
  console.log(`totalCostRate exact bits: ${d.totalCostRate.toString()}`);

  const baseCost = BigInt(Math.floor(d.totalCostRate * 1_000_000_000));
  console.log(`Base totalCost: ${baseCost}`);

  const sc = d.securityCommitments[0];
  const assetKind = sc.asset?.assetType.case === 'erc20' ? 1 : 0;
  const assetTokenBytes = sc.asset?.assetType.case === 'erc20' ? sc.asset.assetType.value : new Uint8Array(20);
  const assetToken = `0x${Array.from(assetTokenBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const exposureBps = sc.exposurePercent * 100;

  console.log(`\nBrute-forcing totalCost in range [${baseCost - 100n}, ${baseCost + 100n}]...`);

  for (let offset = -100n; offset <= 100n; offset++) {
    const tryTotalCost = baseCost + offset;
    const digest = computeDigest(
      d.blueprintId, d.ttlBlocks, tryTotalCost,
      d.timestamp, d.expiry,
      assetKind, assetToken, exposureBps
    );

    for (const v of [27, 28]) {
      const sig65 = `0x${sigHex}${v.toString(16).padStart(2, '0')}`;
      try {
        const recovered = await recoverAddress({ hash: digest, signature: sig65 });
        if (recovered.toLowerCase() === OPERATOR1.toLowerCase()) {
          console.log(`\n✅ FOUND IT! totalCost=${tryTotalCost} (offset=${offset}) v=${v}`);
          console.log(`   Digest: ${digest}`);
          console.log(`   Expected: ${baseCost}`);
          console.log(`   Difference: ${offset}`);
          return;
        }
      } catch {}
    }
  }

  console.log('\n❌ No match found in range [-100, +100]');

  // Try larger range
  console.log('Trying range [-10000, +10000]...');
  for (let offset = -10000n; offset <= 10000n; offset++) {
    const tryTotalCost = baseCost + offset;
    const digest = computeDigest(
      d.blueprintId, d.ttlBlocks, tryTotalCost,
      d.timestamp, d.expiry,
      assetKind, assetToken, exposureBps
    );

    for (const v of [27, 28]) {
      const sig65 = `0x${sigHex}${v.toString(16).padStart(2, '0')}`;
      try {
        const recovered = await recoverAddress({ hash: digest, signature: sig65 });
        if (recovered.toLowerCase() === OPERATOR1.toLowerCase()) {
          console.log(`\n✅ FOUND IT! totalCost=${tryTotalCost} (offset=${offset}) v=${v}`);
          return;
        }
      } catch {}
    }
  }

  console.log('❌ No match found in range [-10000, +10000]');
}

main().catch(console.error);
