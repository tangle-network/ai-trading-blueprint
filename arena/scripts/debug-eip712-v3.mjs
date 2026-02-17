#!/usr/bin/env node
/**
 * Minimal test: compute domain separator and struct hash separately,
 * then compare manual vs viem to find the exact divergence point.
 */
import { keccak256, encodeAbiParameters, parseAbiParameters, hashTypedData, toBytes, concat, encodePacked, toHex } from 'viem';

const TANGLE = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const CHAIN_ID = 31337;

// ── Step 1: Domain separator ────────────────────────────────────────────

const DOMAIN_TYPEHASH = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const NAME_HASH = keccak256(toBytes("TangleQuote"));
const VERSION_HASH = keccak256(toBytes("1"));

const manualDomainSep = keccak256(
  encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
    [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(CHAIN_ID), TANGLE],
  )
);

console.log("=== Domain Separator ===");
console.log(`Manual:  ${manualDomainSep}`);

// Verify with a simple EIP-712 hash (no struct, just domain)
// Can't isolate domain from viem easily, so let's compute it from a known simple type
// Use empty struct to isolate the domain

// ── Step 2: Test with ZERO quote (no commitments) ──────────────────────

const QUOTE_TYPEHASH = keccak256(toBytes("QuoteDetails(uint64 blueprintId,uint64 ttlBlocks,uint256 totalCost,uint64 timestamp,uint64 expiry,AssetSecurityCommitment[] securityCommitments)AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));

// Empty array hash
const emptyArrayHash = keccak256('0x');  // keccak256 of empty bytes
console.log(`\n=== Empty Array Hash ===`);
console.log(`keccak256('0x'): ${emptyArrayHash}`);

// Manual struct hash with all zeros and empty array
const zeroQuoteHash = keccak256(
  encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
    [QUOTE_TYPEHASH, 0n, 0n, 0n, 0n, 0n, emptyArrayHash],
  )
);

const manualZeroDigest = keccak256(
  encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', manualDomainSep, zeroQuoteHash])
);

const viemZeroDigest = hashTypedData({
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
    blueprintId: 0n,
    ttlBlocks: 0n,
    totalCost: 0n,
    timestamp: 0n,
    expiry: 0n,
    securityCommitments: [],
  },
});

console.log(`\n=== Zero Quote Digest ===`);
console.log(`Manual: ${manualZeroDigest}`);
console.log(`Viem:   ${viemZeroDigest}`);
console.log(`Match:  ${manualZeroDigest === viemZeroDigest}`);

// ── Step 3: Check abi encoding byte-by-byte ──────────────────────────────

const manualEncoded = encodeAbiParameters(
  parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
  [QUOTE_TYPEHASH, 0n, 0n, 0n, 0n, 0n, emptyArrayHash],
);
console.log(`\nManual encoded length: ${(manualEncoded.length - 2) / 2} bytes`);
console.log(`First 128 hex chars: ${manualEncoded.slice(0, 130)}`);

// ── Step 4: Manually build the concat for \x19\x01 ──────────────────────
const prefix1901 = new Uint8Array([0x19, 0x01]);
const domBytes = toBytes(manualDomainSep);
const hashBytes = toBytes(zeroQuoteHash);
const fullPayload = new Uint8Array(2 + 32 + 32);
fullPayload.set(prefix1901, 0);
fullPayload.set(domBytes, 2);
fullPayload.set(hashBytes, 34);
const manualDigest2 = keccak256(fullPayload);
console.log(`\nManual digest (v2): ${manualDigest2}`);
console.log(`Match v1:           ${manualZeroDigest === manualDigest2}`);

// ── Step 5: With ONE security commitment ────────────────────────────────

console.log(`\n=== With 1 Security Commitment ===`);

const ASSET_TYPEHASH = keccak256(toBytes("Asset(uint8 kind,address token)"));
const COMMITMENT_TYPEHASH = keccak256(toBytes("AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));

// ERC20 zero-address, 1000 bps
const assetHash = keccak256(
  encodeAbiParameters(parseAbiParameters('bytes32, uint8, address'), [ASSET_TYPEHASH, 1, '0x0000000000000000000000000000000000000000'])
);
const commitmentHash = keccak256(
  encodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint16'), [COMMITMENT_TYPEHASH, assetHash, 1000])
);
const commitmentsArrayHash = keccak256(commitmentHash);

console.log(`assetHash:        ${assetHash}`);
console.log(`commitmentHash:   ${commitmentHash}`);
console.log(`arrayHash:        ${commitmentsArrayHash}`);

const quoteHashWithCommit = keccak256(
  encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
    [QUOTE_TYPEHASH, 0n, 216000n, 22874400000n, 1771296651n, 1771296951n, commitmentsArrayHash],
  )
);
const manualDigestWithCommit = keccak256(
  encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', manualDomainSep, quoteHashWithCommit])
);

const viemDigestWithCommit = hashTypedData({
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
    blueprintId: 0n,
    ttlBlocks: 216000n,
    totalCost: 22874400000n,
    timestamp: 1771296651n,
    expiry: 1771296951n,
    securityCommitments: [{
      asset: { kind: 1, token: '0x0000000000000000000000000000000000000000' },
      exposureBps: 1000,
    }],
  },
});

console.log(`\nManual: ${manualDigestWithCommit}`);
console.log(`Viem:   ${viemDigestWithCommit}`);
console.log(`Match:  ${manualDigestWithCommit === viemDigestWithCommit}`);
