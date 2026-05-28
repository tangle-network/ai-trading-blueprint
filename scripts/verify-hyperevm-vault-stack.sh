#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN_ID="${CHAIN_ID:-999}"
RPC_URL="${RPC_URL:-}"
MANIFEST="${MANIFEST:-$ROOT_DIR/deployments/$CHAIN_ID/hyperliquid-vault.json}"

cd "$ROOT_DIR"

for tool in cast forge jq node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' was not found" >&2
    exit 1
  fi
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: missing deployment manifest: $MANIFEST" >&2
  exit 1
fi
if [[ -z "$RPC_URL" ]]; then
  echo "ERROR: RPC_URL is required" >&2
  exit 1
fi

actual_chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [[ "$actual_chain_id" != "$CHAIN_ID" ]]; then
  echo "ERROR: RPC $RPC_URL is chain $actual_chain_id, expected $CHAIN_ID" >&2
  exit 1
fi

forge build -q

RPC_URL="$RPC_URL" MANIFEST="$MANIFEST" node <<'NODE'
const fs = require('fs');
const cp = require('child_process');

const rpc = process.env.RPC_URL;
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST, 'utf8'));
const contracts = [
  ['HyperliquidVault', 'contracts/out/HyperliquidVault.sol/HyperliquidVault.json', manifest.vaultImplementation],
  ['HyperliquidTradeValidator', 'contracts/out/HyperliquidTradeValidator.sol/HyperliquidTradeValidator.json', manifest.tradeValidator],
  ['HyperliquidVaultFactory', 'contracts/out/HyperliquidVaultFactory.sol/HyperliquidVaultFactory.json', manifest.vaultFactory],
  ['HyperliquidVaultDeployer', 'contracts/out/HyperliquidVaultDeployer.sol/HyperliquidVaultDeployer.json', manifest.vaultDeployer],
  ['VaultShareDeployer', 'contracts/out/VaultShareDeployer.sol/VaultShareDeployer.json', manifest.vaultShareDeployer],
];

function run(args) {
  return cp.execFileSync('cast', args, { encoding: 'utf8' }).trim();
}

function norm(hex) {
  return String(hex || '').trim().toLowerCase().replace(/^0x/, '');
}

function immutableRefs(artifact) {
  const refsByFile = artifact.deployedBytecode && artifact.deployedBytecode.immutableReferences
    ? artifact.deployedBytecode.immutableReferences
    : {};
  const refs = [];
  Object.keys(refsByFile).forEach((file) => {
    refsByFile[file].forEach((ref) => refs.push(ref));
  });
  refs.sort((a, b) => a.start - b.start);
  return refs;
}

function maskRefs(code, refs) {
  const chars = code.split('');
  refs.forEach((ref) => {
    const start = ref.start * 2;
    const end = start + ref.length * 2;
    for (let i = start; i < end; i += 1) chars[i] = '0';
  });
  return chars.join('');
}

let failed = false;
contracts.forEach(([label, artifactPath, address]) => {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const deployed = norm(run(['code', address, '--rpc-url', rpc]));
  const expected = norm(artifact.deployedBytecode.object);
  const refs = immutableRefs(artifact);
  const match = maskRefs(deployed, refs) === maskRefs(expected, refs);
  const deployedBytes = deployed.length / 2;
  const expectedBytes = expected.length / 2;
  console.log(`${match ? 'MATCH' : 'MISMATCH'} ${label} ${address} deployedBytes=${deployedBytes} expectedBytes=${expectedBytes} immutableRefs=${refs.length}`);
  if (!match || deployedBytes === 0) failed = true;
});

function assertEq(label, actual, expected) {
  const ok = norm(actual) === norm(expected);
  console.log(`${ok ? 'OK' : 'ERROR'} ${label} actual=${actual} expected=${expected}`);
  if (!ok) failed = true;
}

assertEq('factory.owner', run(['call', manifest.vaultFactory, 'owner()(address)', '--rpc-url', rpc]), manifest.deployer);
assertEq('factory.tradeValidator', run(['call', manifest.vaultFactory, 'tradeValidator()(address)', '--rpc-url', rpc]), manifest.tradeValidator);
assertEq('factory.deployer', run(['call', manifest.vaultFactory, 'deployer()(address)', '--rpc-url', rpc]), manifest.vaultDeployer);
assertEq('factory.shareDeployer', run(['call', manifest.vaultFactory, 'shareDeployer()(address)', '--rpc-url', rpc]), manifest.vaultShareDeployer);
assertEq('vaultDeployer.factory', run(['call', manifest.vaultDeployer, 'factory()(address)', '--rpc-url', rpc]), manifest.vaultFactory);
assertEq('vaultDeployer.implementation', run(['call', manifest.vaultDeployer, 'implementation()(address)', '--rpc-url', rpc]), manifest.vaultImplementation);
assertEq('shareDeployer.factory', run(['call', manifest.vaultShareDeployer, 'factory()(address)', '--rpc-url', rpc]), manifest.vaultFactory);
assertEq('tradeValidator.owner', run(['call', manifest.tradeValidator, 'owner()(address)', '--rpc-url', rpc]), manifest.vaultFactory);

if (failed) process.exit(1);
NODE

echo "HyperEVM vault stack verified on chain $CHAIN_ID."
