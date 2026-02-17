#!/usr/bin/env node
/**
 * Debug EIP-712: compare manual hash vs viem, and test signature recovery
 * with the actual quote from the pricing engine.
 */
import { keccak256, encodeAbiParameters, parseAbiParameters, hashTypedData, recoverAddress, toBytes, concat } from 'viem';

const TANGLE = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const CHAIN_ID = 31337;
const OPERATOR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// ── Domain ──────────────────────────────────────────────────────────────

const DOMAIN_TYPEHASH = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const NAME_HASH = keccak256(toBytes("TangleQuote"));
const VERSION_HASH = keccak256(toBytes("1"));

const domainSep = keccak256(
  encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
    [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(CHAIN_ID), TANGLE],
  )
);

// ── TypeHashes ──────────────────────────────────────────────────────────

const ASSET_TYPEHASH = keccak256(toBytes("Asset(uint8 kind,address token)"));
const COMMITMENT_TYPEHASH = keccak256(toBytes("AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));
const QUOTE_TYPEHASH = keccak256(toBytes("QuoteDetails(uint64 blueprintId,uint64 ttlBlocks,uint256 totalCost,uint64 timestamp,uint64 expiry,AssetSecurityCommitment[] securityCommitments)AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));

// ── Fetch a quote and test ──────────────────────────────────────────────

async function main() {
  const { createClient } = await import('@connectrpc/connect');
  const { createGrpcWebTransport } = await import('@connectrpc/connect-web');
  const { PricingEngine } = await import('../src/lib/gen/pricing_pb.ts');
  const { sha256 } = await import('viem');

  // PoW
  const blueprintId = 0n;
  const ttlBlocks = BigInt(Math.floor((30 * 86400) / 12));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  function generateChallenge(bid, ts) {
    const input = new Uint8Array(16);
    const view = new DataView(input.buffer);
    view.setBigUint64(0, bid, false);
    view.setBigUint64(8, ts, false);
    return sha256(input, 'bytes');
  }

  function checkDifficulty(hash, diff) {
    const zB = Math.floor(diff / 8), zb = diff % 8;
    for (let i = 0; i < zB; i++) if (hash[i] !== 0) return false;
    if (zb > 0 && (hash[zB] & (0xFF << (8 - zb))) !== 0) return false;
    return true;
  }

  console.log('Solving PoW...');
  const challenge = generateChallenge(blueprintId, timestamp);
  const buf = new Uint8Array(challenge.length + 8);
  buf.set(challenge, 0);
  const view = new DataView(buf.buffer);
  let proofOfWork;
  for (let nonce = 0; nonce < 0x1_0000_0000; nonce++) {
    view.setBigUint64(challenge.length, BigInt(nonce), false);
    const hash = sha256(buf, 'bytes');
    if (checkDifficulty(hash, 20)) {
      const proof = new Uint8Array(48);
      const pv = new DataView(proof.buffer);
      pv.setBigUint64(0, 32n, true);
      proof.set(hash, 8);
      pv.setBigUint64(40, BigInt(nonce), true);
      proofOfWork = proof;
      break;
    }
  }

  const transport = createGrpcWebTransport({ baseUrl: 'http://127.0.0.1:50051' });
  const client = createClient(PricingEngine, transport);

  console.log('Fetching quote...');
  const response = await client.getPrice({
    blueprintId, ttlBlocks, proofOfWork, challengeTimestamp: timestamp,
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
  const PRICING_SCALE = 1_000_000_000;
  const totalCost = BigInt(Math.floor(d.totalCostRate * PRICING_SCALE));

  console.log(`\nQuote: blueprintId=${d.blueprintId} ttl=${d.ttlBlocks} totalCost=${totalCost} ts=${d.timestamp} exp=${d.expiry}`);
  console.log(`Commitments: ${d.securityCommitments.length}`);

  const sc = d.securityCommitments[0];
  const assetKind = sc.asset?.assetType.case === 'erc20' ? 1 : 0;
  const assetTokenBytes = sc.asset?.assetType.case === 'erc20' ? sc.asset.assetType.value : new Uint8Array(20);
  const assetToken = `0x${Array.from(assetTokenBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const exposureBps = sc.exposurePercent * 100;

  console.log(`  asset: kind=${assetKind} token=${assetToken}`);
  console.log(`  exposureBps: ${exposureBps}`);

  const rawSig = response.signature;
  console.log(`  signature: ${rawSig.length} bytes`);

  // ── Manual EIP-712 hash (matching Rust code) ──────────────────────────

  const assetHash = keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, uint8, address'), [ASSET_TYPEHASH, assetKind, assetToken])
  );

  const commitmentHash = keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint16'), [COMMITMENT_TYPEHASH, assetHash, exposureBps])
  );

  const commitmentsArrayHash = keccak256(commitmentHash);

  const quoteHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
      [QUOTE_TYPEHASH, d.blueprintId, d.ttlBlocks, totalCost, d.timestamp, d.expiry, commitmentsArrayHash],
    )
  );

  const manualDigest = keccak256(
    concat([toBytes('0x1901'), toBytes(domainSep), toBytes(quoteHash)])
  );

  // ── viem hashTypedData ────────────────────────────────────────────────

  const viemDigest = hashTypedData({
    domain: { name: 'TangleQuote', version: '1', chainId: CHAIN_ID, verifyingContract: TANGLE },
    types: {
      QuoteDetails: [
        { name: 'blueprintId', type: 'uint64' },
        { name: 'ttlBlocks', type: 'uint64' },
        { name: 'totalCost', type: 'uint256' },
        { name: 'timestamp', type: 'uint64' },
        { name: 'expiry', type: 'uint64' },
        { name: 'securityCommitments', type: 'AssetSecurityCommitment[]' },
      ],
      AssetSecurityCommitment: [
        { name: 'asset', type: 'Asset' },
        { name: 'exposureBps', type: 'uint16' },
      ],
      Asset: [
        { name: 'kind', type: 'uint8' },
        { name: 'token', type: 'address' },
      ],
    },
    primaryType: 'QuoteDetails',
    message: {
      blueprintId: d.blueprintId,
      ttlBlocks: d.ttlBlocks,
      totalCost,
      timestamp: d.timestamp,
      expiry: d.expiry,
      securityCommitments: [{
        asset: { kind: assetKind, token: assetToken },
        exposureBps,
      }],
    },
  });

  console.log(`\nManual digest: ${manualDigest}`);
  console.log(`Viem digest:   ${viemDigest}`);
  console.log(`Match: ${manualDigest === viemDigest}`);

  // ── Try signature recovery with BOTH digests ──────────────────────────

  const sigHex = Array.from(rawSig).map(b => b.toString(16).padStart(2, '0')).join('');

  for (const [label, digest] of [['manual', manualDigest], ['viem', viemDigest]]) {
    console.log(`\n--- Recovery with ${label} digest ---`);
    for (const v of [27, 28]) {
      const sig65 = `0x${sigHex}${v.toString(16).padStart(2, '0')}`;
      try {
        const recovered = await recoverAddress({ hash: digest, signature: sig65 });
        const matches = recovered.toLowerCase() === OPERATOR1.toLowerCase();
        console.log(`  v=${v}: ${recovered} ${matches ? '✅ MATCH!' : ''}`);
      } catch (err) {
        console.log(`  v=${v}: error ${err.message?.slice(0, 80)}`);
      }
    }
  }
}

main().catch(console.error);
