#!/usr/bin/env node
/**
 * Debug EIP-712 digest computation: compare manual hash vs viem hashTypedData
 * to find where the mismatch is with the pricing engine's signing.
 */
import { keccak256, encodeAbiParameters, parseAbiParameters, hashTypedData, recoverAddress, toHex, toBytes, concat, pad, numberToHex } from 'viem';

const TANGLE = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const CHAIN_ID = 31337;

// ── Compute domain separator manually (matching Rust) ────────────────────

const DOMAIN_TYPEHASH = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const NAME_HASH = keccak256(toBytes("TangleQuote"));
const VERSION_HASH = keccak256(toBytes("1"));

console.log("=== Domain ===");
console.log(`DOMAIN_TYPEHASH: ${DOMAIN_TYPEHASH}`);
console.log(`NAME_HASH:       ${NAME_HASH}`);
console.log(`VERSION_HASH:    ${VERSION_HASH}`);

const domainSep = keccak256(
  encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
    [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(CHAIN_ID), TANGLE],
  )
);
console.log(`Domain separator (manual): ${domainSep}`);

// ── Compute struct hashes manually (matching Rust) ───────────────────────

const ASSET_TYPEHASH = keccak256(toBytes("Asset(uint8 kind,address token)"));
const COMMITMENT_TYPEHASH = keccak256(toBytes("AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));
const QUOTE_TYPEHASH = keccak256(toBytes("QuoteDetails(uint64 blueprintId,uint64 ttlBlocks,uint256 totalCost,uint64 timestamp,uint64 expiry,AssetSecurityCommitment[] securityCommitments)AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)"));

console.log("\n=== TypeHashes ===");
console.log(`ASSET_TYPEHASH:      ${ASSET_TYPEHASH}`);
console.log(`COMMITMENT_TYPEHASH: ${COMMITMENT_TYPEHASH}`);
console.log(`QUOTE_TYPEHASH:      ${QUOTE_TYPEHASH}`);

// ── Example quote values ─────────────────────────────────────────────────

const blueprintId = 0n;
const ttlBlocks = 216000n;
const totalCost = 22874400000n;
const timestamp = 1771296502n;
const expiry = 1771296802n;

// Security commitment: ERC20 zero-address, 1000 bps (10% * 100)
const assetKind = 1;  // ERC20
const assetToken = '0x0000000000000000000000000000000000000000';
const exposureBps = 1000;

console.log("\n=== Quote Fields ===");
console.log(`blueprintId: ${blueprintId}`);
console.log(`ttlBlocks:   ${ttlBlocks}`);
console.log(`totalCost:   ${totalCost}`);
console.log(`timestamp:   ${timestamp}`);
console.log(`expiry:      ${expiry}`);
console.log(`asset kind:  ${assetKind}`);
console.log(`asset token: ${assetToken}`);
console.log(`exposureBps: ${exposureBps}`);

// Hash the asset struct
const assetHash = keccak256(
  encodeAbiParameters(
    parseAbiParameters('bytes32, uint8, address'),
    [ASSET_TYPEHASH, assetKind, assetToken],
  )
);
console.log(`\nassetHash: ${assetHash}`);

// Hash the commitment
const commitmentHash = keccak256(
  encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, uint16'),
    [COMMITMENT_TYPEHASH, assetHash, exposureBps],
  )
);
console.log(`commitmentHash: ${commitmentHash}`);

// Hash the commitments array: keccak256(concat(commitmentHash1, ...))
const commitmentsArrayHash = keccak256(commitmentHash);
console.log(`commitmentsArrayHash: ${commitmentsArrayHash}`);

// Hash the full QuoteDetails struct
const quoteHash = keccak256(
  encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, uint64, uint256, uint64, uint64, bytes32'),
    [QUOTE_TYPEHASH, blueprintId, ttlBlocks, totalCost, timestamp, expiry, commitmentsArrayHash],
  )
);
console.log(`quoteHash (manual): ${quoteHash}`);

// Compute EIP-712 digest manually
const digest = keccak256(
  concat([toBytes('0x1901'), toBytes(domainSep), toBytes(quoteHash)])
);
console.log(`\nDigest (manual): ${digest}`);

// ── Compare with viem's hashTypedData ────────────────────────────────────

const viemDigest = hashTypedData({
  domain: {
    name: 'TangleQuote',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: TANGLE,
  },
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
    blueprintId,
    ttlBlocks,
    totalCost,
    timestamp,
    expiry,
    securityCommitments: [{
      asset: { kind: assetKind, token: assetToken },
      exposureBps,
    }],
  },
});
console.log(`Digest (viem):   ${viemDigest}`);
console.log(`\nDigests match: ${digest === viemDigest}`);
