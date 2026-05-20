# Zero-knowledge proof toolchains. Circom + snarkjs cover the
# Groth16 / PLONK frontends; halo2 / starkware tooling is mostly
# rust-side and pulled through cargo plugins.
{ pkgs, lib }:

with pkgs; [
  circom
]
