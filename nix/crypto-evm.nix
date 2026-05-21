# EVM / Solidity toolchain + the security analyzers blueprint repos use
# in CI. Foundry comes from the foundry-nix overlay (passed in).
{ pkgs, lib }:

with pkgs; [
  # Foundry suite.
  foundry-bin

  # Solidity compilers.
  solc
  solc-select

  # Formatters / config.
  taplo

  # Static analysis.
  slither-analyzer

  # Fuzzing.
  echidna

  # ABI / bytecode tooling.
  go-ethereum
]
