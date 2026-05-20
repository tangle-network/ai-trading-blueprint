# Rust toolchain + the most-used cargo plugins. The toolchain version
# comes from rust-toolchain.toml; everything else is the latest in
# nixpkgs at the channel pin.
{ pkgs, lib, toolchain }:

[
  toolchain
  pkgs.rust-analyzer-unwrapped
  pkgs.sccache

  # Test running / coverage.
  pkgs.cargo-nextest
  pkgs.cargo-llvm-cov
  pkgs.cargo-tarpaulin

  # Dependency hygiene.
  pkgs.cargo-audit
  pkgs.cargo-deny
  pkgs.cargo-outdated
  pkgs.cargo-machete
  pkgs.cargo-udeps
  pkgs.cargo-edit
  pkgs.cargo-cache
  pkgs.cargo-license
  pkgs.cargo-msrv

  # Workflow.
  pkgs.cargo-watch
  pkgs.cargo-expand
  pkgs.cargo-make
  pkgs.cargo-release
  pkgs.cargo-workspaces
  pkgs.cargo-bisect-rustc

  # Performance / size.
  pkgs.cargo-bloat
  pkgs.cargo-flamegraph
  pkgs.cargo-criterion
  pkgs.flamegraph

  # WASM / cross.
  pkgs.wasm-pack
  pkgs.wasm-bindgen-cli
  pkgs.wasm-tools
  pkgs.wasmtime
  pkgs.cargo-component

  # Misc Rust-ecosystem tools.
  pkgs.bacon
  pkgs.just
  pkgs.tokei
  pkgs.scc
  pkgs.mdbook
  pkgs.maturin
  pkgs.cargo-mutants
  pkgs.cargo-semver-checks
  pkgs.cargo-vet
]
