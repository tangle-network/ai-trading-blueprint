#!/usr/bin/env node
/**
 * Diagnostic: Fetch a real quote from the pricing engine, then simulate
 * createServiceFromQuotes via eth_call to see the exact revert reason.
 */
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, decodeErrorResult, toHex, keccak256 } from 'viem';

const RPC = 'http://127.0.0.1:8545';
const TANGLE = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const USER = '0xd04E36A1C370c6115e1C676838AcD0b430d740F3'; // user's wallet
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OPERATOR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OPERATOR2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const client = createPublicClient({ transport: http(RPC) });

// ── 1. Check basic prerequisites ────────────────────────────────────────

async function checkPrereqs() {
  console.log('=== Prerequisites ===');

  // Blueprint operator count
  const opCount = await client.readContract({
    address: TANGLE,
    abi: [{ type: 'function', name: 'blueprintOperatorCount', inputs: [{ name: 'blueprintId', type: 'uint64' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' }],
    functionName: 'blueprintOperatorCount',
    args: [0n],
  });
  console.log(`Blueprint 0 operator count: ${opCount}`);

  // Check each operator
  for (const [name, addr] of [['Operator1', OPERATOR1], ['Operator2', OPERATOR2]]) {
    const registered = await client.readContract({
      address: TANGLE,
      abi: [{ type: 'function', name: 'isOperatorRegistered', inputs: [{ name: 'blueprintId', type: 'uint64' }, { name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' }],
      functionName: 'isOperatorRegistered',
      args: [0n, addr],
    });
    console.log(`${name} (${addr}) registered: ${registered}`);
  }

  // Check if user is permitted caller on service 0
  const isPermitted = await client.readContract({
    address: TANGLE,
    abi: [{ type: 'function', name: 'isPermittedCaller', inputs: [{ name: 'serviceId', type: 'uint64' }, { name: 'caller', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' }],
    functionName: 'isPermittedCaller',
    args: [0n, USER],
  });
  console.log(`User permitted on service 0: ${isPermitted}`);

  // Check service count (to know next serviceId)
  // Try to read how many services exist
  const block = await client.getBlock();
  console.log(`Current block timestamp: ${block.timestamp}`);
  console.log();
}

// ── 2. Fetch quote from pricing engine via gRPC-Web ──────────────────────

async function fetchQuoteHttp(port) {
  // gRPC-Web uses HTTP POST with specific content-type
  // We'll use the connect-es library approach
  const { createClient } = await import('@connectrpc/connect');
  const { createGrpcWebTransport } = await import('@connectrpc/connect-web');
  const { PricingEngine, GetPriceRequestSchema } = await import('../src/lib/gen/pricing_pb.ts');

  const transport = createGrpcWebTransport({ baseUrl: `http://127.0.0.1:${port}` });
  const pricingClient = createClient(PricingEngine, transport);

  const blueprintId = 0n;
  const ttlBlocks = BigInt(Math.floor((30 * 86400) / 12)); // ~216000 blocks
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  // Solve PoW
  const { sha256 } = await import('viem');

  function generateChallenge(bid, ts) {
    const input = new Uint8Array(16);
    const view = new DataView(input.buffer);
    view.setBigUint64(0, bid, false);
    view.setBigUint64(8, ts, false);
    return sha256(input, 'bytes');
  }

  function checkDifficulty(hash, difficulty) {
    const zeroBytes = Math.floor(difficulty / 8);
    const zeroBits = difficulty % 8;
    for (let i = 0; i < zeroBytes; i++) {
      if (hash[i] !== 0) return false;
    }
    if (zeroBits > 0) {
      const mask = 0xFF << (8 - zeroBits);
      if ((hash[zeroBytes] & mask) !== 0) return false;
    }
    return true;
  }

  console.log(`Solving PoW for port ${port}...`);
  const challenge = generateChallenge(blueprintId, timestamp);
  const buf = new Uint8Array(challenge.length + 8);
  buf.set(challenge, 0);
  const view = new DataView(buf.buffer);

  let proofOfWork;
  for (let nonce = 0; nonce < 0x1_0000_0000; nonce++) {
    view.setBigUint64(challenge.length, BigInt(nonce), false);
    const hash = sha256(buf, 'bytes');
    if (checkDifficulty(hash, 20)) {
      const proof = new Uint8Array(8 + 32 + 8);
      const pv = new DataView(proof.buffer);
      pv.setBigUint64(0, 32n, true);
      proof.set(hash, 8);
      pv.setBigUint64(40, BigInt(nonce), true);
      proofOfWork = proof;
      console.log(`  PoW solved: nonce=${nonce}`);
      break;
    }
  }

  console.log(`  Calling GetPrice...`);
  const response = await pricingClient.getPrice({
    blueprintId,
    ttlBlocks,
    proofOfWork,
    challengeTimestamp: timestamp,
    resourceRequirements: [
      { kind: 'CPU', count: 1n },
      { kind: 'MemoryMB', count: 1024n },
      { kind: 'StorageMB', count: 10240n },
    ],
    securityRequirements: {
      asset: { assetType: { case: 'erc20', value: new Uint8Array(20) } },
      minimumExposurePercent: 10,
      maximumExposurePercent: 100,
    },
  });

  console.log(`  Quote received:`);
  console.log(`    totalCostRate: ${response.quoteDetails.totalCostRate}`);
  console.log(`    blueprintId: ${response.quoteDetails.blueprintId}`);
  console.log(`    ttlBlocks: ${response.quoteDetails.ttlBlocks}`);
  console.log(`    timestamp: ${response.quoteDetails.timestamp}`);
  console.log(`    expiry: ${response.quoteDetails.expiry}`);
  console.log(`    securityCommitments: ${response.quoteDetails.securityCommitments.length}`);
  console.log(`    signature length: ${response.signature.length} bytes`);

  return response;
}

// ── 3. Map quote to on-chain format ──────────────────────────────────────

const PRICING_SCALE = 1_000_000_000;

async function mapQuote(response, operatorAddr) {
  const { hashTypedData, recoverAddress } = await import('viem');
  const d = response.quoteDetails;
  const totalCost = BigInt(Math.floor(d.totalCostRate * PRICING_SCALE));

  const securityCommitments = d.securityCommitments.map((sc) => ({
    asset: {
      kind: sc.asset?.assetType.case === 'erc20' ? 1 : 0,
      token: (sc.asset?.assetType.case === 'erc20'
        ? `0x${Array.from(sc.asset.assetType.value).map((b) => b.toString(16).padStart(2, '0')).join('')}`
        : '0x0000000000000000000000000000000000000000'),
    },
    exposureBps: sc.exposurePercent * 100,
  }));

  console.log(`  Mapped totalCost: ${totalCost} (from rate ${d.totalCostRate})`);

  // Recover v byte from 64-byte signature
  const rawHex = Array.from(response.signature).map((b) => b.toString(16).padStart(2, '0')).join('');
  console.log(`  Raw sig (${response.signature.length} bytes): 0x${rawHex.slice(0, 16)}...${rawHex.slice(-8)}`);

  const digest = hashTypedData({
    domain: {
      name: 'TangleQuote',
      version: '1',
      chainId: 31337,
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
      blueprintId: d.blueprintId,
      ttlBlocks: d.ttlBlocks,
      totalCost,
      timestamp: d.timestamp,
      expiry: d.expiry,
      securityCommitments: securityCommitments.map((sc) => ({
        asset: { kind: sc.asset.kind, token: sc.asset.token },
        exposureBps: sc.exposureBps,
      })),
    },
  });
  console.log(`  EIP-712 digest: ${digest}`);

  let sigHex;
  for (const v of [27, 28]) {
    const sig65 = `0x${rawHex}${v.toString(16).padStart(2, '0')}`;
    try {
      const recovered = await recoverAddress({ hash: digest, signature: sig65 });
      console.log(`  v=${v}: recovered ${recovered}`);
      if (recovered.toLowerCase() === operatorAddr.toLowerCase()) {
        sigHex = sig65;
        console.log(`  ✅ v=${v} matches operator!`);
        break;
      }
    } catch (err) {
      console.log(`  v=${v}: error ${err.message?.slice(0, 80)}`);
    }
  }

  if (!sigHex) {
    console.log(`  ⚠️ No v matched operator ${operatorAddr}, using v=27 as fallback`);
    sigHex = `0x${rawHex}1b`;
  }

  return {
    details: {
      blueprintId: d.blueprintId,
      ttlBlocks: d.ttlBlocks,
      totalCost,
      timestamp: d.timestamp,
      expiry: d.expiry,
      securityCommitments,
    },
    signature: sigHex,
    operator: operatorAddr,
  };
}

// ── 4. Simulate createServiceFromQuotes ──────────────────────────────────

const createServiceAbi = [
  {
    type: 'function', name: 'createServiceFromQuotes',
    inputs: [
      { name: 'blueprintId', type: 'uint64' },
      { name: 'quotes', type: 'tuple[]', components: [
        { name: 'details', type: 'tuple', components: [
          { name: 'blueprintId', type: 'uint64' },
          { name: 'ttlBlocks', type: 'uint64' },
          { name: 'totalCost', type: 'uint256' },
          { name: 'timestamp', type: 'uint64' },
          { name: 'expiry', type: 'uint64' },
          { name: 'securityCommitments', type: 'tuple[]', components: [
            { name: 'asset', type: 'tuple', components: [
              { name: 'kind', type: 'uint8' },
              { name: 'token', type: 'address' },
            ] },
            { name: 'exposureBps', type: 'uint16' },
          ] },
        ] },
        { name: 'signature', type: 'bytes' },
        { name: 'operator', type: 'address' },
      ] },
      { name: 'config', type: 'bytes' },
      { name: 'permittedCallers', type: 'address[]' },
      { name: 'ttl', type: 'uint64' },
    ],
    outputs: [{ name: 'serviceId', type: 'uint64' }],
    stateMutability: 'payable',
  },
];

async function simulateCall(quotes) {
  console.log('\n=== Simulating createServiceFromQuotes ===');

  const ttlBlocks = BigInt(Math.floor((30 * 86400) / 12));
  const totalCost = quotes.reduce((sum, q) => sum + q.details.totalCost, 0n);

  console.log(`TTL blocks: ${ttlBlocks}`);
  console.log(`Total cost (msg.value): ${totalCost} wei`);
  console.log(`Quotes: ${quotes.length}`);
  console.log(`Caller: ${USER}`);

  // Minimal config bytes
  const { encodeAbiParameters, parseAbiParameters, zeroAddress } = await import('viem');
  const config = encodeAbiParameters(
    parseAbiParameters('string, string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[]'),
    ['', '', '{}', '{}', '{}', zeroAddress, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', [USER], 1n, 31337n, '', '', 2n, 2048n, 30n, []],
  );

  const calldata = encodeFunctionData({
    abi: createServiceAbi,
    functionName: 'createServiceFromQuotes',
    args: [0n, quotes, config, [USER], ttlBlocks],
  });

  console.log(`\nCalldata length: ${calldata.length} chars`);
  console.log(`First 66 chars: ${calldata.slice(0, 66)}`);

  try {
    const result = await client.call({
      to: TANGLE,
      data: calldata,
      value: totalCost,
      account: USER,
    });
    console.log(`\n✅ SUCCESS! Result: ${result.data}`);
  } catch (err) {
    console.log(`\n❌ REVERTED!`);
    console.log(`Error message: ${err.message?.slice(0, 500)}`);

    // Try to extract revert data
    if (err.data) {
      console.log(`Revert data: ${err.data}`);
    }

    // Check for specific error selectors
    const errorSelectors = {
      '0xc2a825f5': 'UnknownSelector(bytes4)',
      '0x0a55512f': 'JobAlreadyCompleted(uint64,uint64)',
      '0x5d04b45b': 'BlueprintNotActive(uint64)',
      '0x70a43658': 'DuplicateOperatorQuote(address)',
      '0xb8a0f128': 'OperatorNotRegistered(uint64,address)',
      '0xa47e55db': 'QuoteTTLMismatch(address,uint64,uint64)',
      '0x13be252b': 'InvalidSignature()',
      '0x8baa579f': 'InvalidSignatureS()',
      '0xf645eedf': 'InvalidSignatureLength(uint256)',
      '0x1626ba7e': 'InvalidQuoteSignature(address)',
    };

    const raw = err.data || err.message;
    for (const [sel, name] of Object.entries(errorSelectors)) {
      if (raw?.includes(sel.slice(2))) {
        console.log(`Likely error: ${name} (selector ${sel})`);
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  await checkPrereqs();

  console.log('\n=== Fetching Quotes ===');

  let quote1, quote2;
  try {
    const resp1 = await fetchQuoteHttp(50051);
    quote1 = mapQuote(resp1, OPERATOR1);
  } catch (err) {
    console.log(`Failed to get quote from operator1 (port 50051): ${err.message}`);
  }

  try {
    const resp2 = await fetchQuoteHttp(50052);
    quote2 = mapQuote(resp2, OPERATOR2);
  } catch (err) {
    console.log(`Failed to get quote from operator2 (port 50052): ${err.message}`);
  }

  const quotes = [quote1, quote2].filter(Boolean);
  if (quotes.length === 0) {
    console.log('\nNo quotes fetched. Cannot simulate.');
    return;
  }

  await simulateCall(quotes);
}

main().catch(console.error);
