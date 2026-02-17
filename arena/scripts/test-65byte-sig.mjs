#!/usr/bin/env node
/**
 * Test that the fixed pricing engine returns 65-byte signatures
 * that recover to the operator address using the correct EIP-712 digest.
 */
import { keccak256, encodeAbiParameters, parseAbiParameters, toBytes, encodePacked, recoverAddress } from 'viem';

const TANGLE = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const OPERATOR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

async function main() {
  const { createClient } = await import('@connectrpc/connect');
  const { createGrpcWebTransport } = await import('@connectrpc/connect-web');
  const { PricingEngine } = await import('../src/lib/gen/pricing_pb.ts');
  const { sha256 } = await import('viem');

  const blueprintId = 0n;
  const ttlBlocks = BigInt(Math.floor((30 * 86400) / 12));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  // PoW
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

  console.log('Signature length:', resp.signature.length, 'bytes');

  const d = resp.quoteDetails;
  const totalCost = BigInt(Math.floor(d.totalCostRate * 1_000_000_000));
  const sc = d.securityCommitments[0];
  const exposureBps = sc.exposurePercent * 100;

  console.log('Proto fields:');
  console.log('  blueprintId:', d.blueprintId);
  console.log('  ttlBlocks:', d.ttlBlocks);
  console.log('  totalCostRate:', d.totalCostRate, '→ totalCost:', totalCost.toString());
  console.log('  timestamp:', d.timestamp);
  console.log('  expiry:', d.expiry);
  console.log('  exposureBps:', exposureBps);
  console.log('  v byte:', resp.signature[64]);

  // EIP-712 computation matching Solidity
  const DOMAIN_SEP = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
    [
      keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
      keccak256(toBytes('TangleQuote')),
      keccak256(toBytes('1')),
      31337n,
      TANGLE,
    ]
  ));

  const QUOTE_TH = keccak256(toBytes('QuoteDetails(uint64 blueprintId,uint64 ttlBlocks,uint256 totalCost,uint64 timestamp,uint64 expiry,AssetSecurityCommitment[] securityCommitments)AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)'));
  const COMMIT_TH = keccak256(toBytes('AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)'));
  const ASSET_TH = keccak256(toBytes('Asset(uint8 kind,address token)'));

  const ah = keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint8, address'), [ASSET_TH, 1, '0x0000000000000000000000000000000000000000']));
  const ch = keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint16'), [COMMIT_TH, ah, exposureBps]));
  const arrH = keccak256(ch);
  const qh = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
    [QUOTE_TH, d.blueprintId, d.ttlBlocks, totalCost, d.timestamp, d.expiry, arrH]
  ));
  const digest = keccak256(encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', DOMAIN_SEP, qh]));

  // Use the 65-byte signature directly
  const sigHex = '0x' + Array.from(resp.signature).map(b => b.toString(16).padStart(2, '0')).join('');

  try {
    const recovered = await recoverAddress({ hash: digest, signature: sigHex });
    console.log('\nRecovered:', recovered);
    console.log('Expected:', OPERATOR1);
    if (recovered.toLowerCase() === OPERATOR1.toLowerCase()) {
      console.log('✅ SIGNATURE VERIFIED — EIP-712 digest matches on-chain contract');
    } else {
      console.log('❌ MISMATCH — recovered address does not match operator');
    }
  } catch (e) {
    console.error('Recovery failed:', e.message);
  }
}

main().catch(console.error);
