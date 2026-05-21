# Non-EVM L1 toolchains. Anything broken / unfree / not in nixpkgs is
# intentionally omitted and added later via fetchurl-style external
# CLIs.
{ pkgs, lib }:

with pkgs; [
  # Solana / Anchor.
  solana-cli
  anchor

  # Tezos / Move adjacent.
  # (sui-cli, aptos-cli, starkli not consistently in nixpkgs 24.11 —
  #  add via external-clis follow-up.)

  # Bitcoin client surface.
  bitcoin
  bitcoind

]
