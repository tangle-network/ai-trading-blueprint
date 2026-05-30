{
  description = "AI Trading Blueprint — dev environment + cacheable multi-language toolchain profile (Cachix: tangle-sandbox)";

  # Shared binary cache so the agent-harness closure (opencode/claude-code/codex
  # /…) and nixpkgs deps resolve from cache instead of rebuilding from source.
  nixConfig = {
    extra-substituters = [ "https://tangle-sandbox.cachix.org" ];
    extra-trusted-public-keys = [
      "tangle-sandbox.cachix.org-1:Phh3AbYMAfvfAHAkxKyRXuLPgPlbA2BJ+u3AKTL5JPM="
    ];
  };

  inputs = {
    # Pinned to nixos-24.11 so the closure shares store paths with the
    # shared `tangle-sandbox` Cachix instance (otherwise nixpkgs-unstable
    # would resolve every transitive dep to a different hash and the
    # cache would never hit on glibc / openssl / mold / clang etc.).
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    foundry = {
      url = "github:shazow/foundry.nix/monthly";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, rust-overlay, foundry, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) foundry.overlay ];
        pkgs = import nixpkgs {
          inherit system overlays;
          config.allowUnfree = true;
        };
        lib = pkgs.lib;
        toolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

        # Per-category package lists. Splitting these out keeps each
        # file focused on one ecosystem; flake.nix only orchestrates
        # which slices land in which profile.
        callGroup = file: import file { inherit pkgs lib; };

        systemDeps      = callGroup ./nix/system.nix;
        coreCLIs        = callGroup ./nix/cli.nix;
        rustDeps        = import ./nix/rust.nix { inherit pkgs lib toolchain; };
        jsDeps          = callGroup ./nix/js.nix;
        pythonDeps      = callGroup ./nix/python.nix;
        goDeps          = callGroup ./nix/go.nix;
        cppDeps         = callGroup ./nix/cpp.nix;
        cryptoEvmDeps   = callGroup ./nix/crypto-evm.nix;
        cryptoL1Deps    = callGroup ./nix/crypto-l1.nix;
        cryptoZkDeps    = callGroup ./nix/crypto-zk.nix;
        aiDeps          = callGroup ./nix/ai.nix;
        mobileDeps      = callGroup ./nix/mobile.nix;
        dbDeps          = callGroup ./nix/databases.nix;
        infraDeps       = callGroup ./nix/infra.nix;
        observabilityDeps = callGroup ./nix/observability.nix;
        mediaDeps       = callGroup ./nix/media.nix;
        languageServers = callGroup ./nix/language-servers.nix;

        # Coding-agent harness CLIs (opencode, claude-code, codex, …). Owned
        # here — duplicated from the shared recipe so the blueprint-sidecar
        # image is self-sufficient (see nix/agent-clis.nix).
        agentClisAttrs  = import ./nix/agent-clis.nix { inherit pkgs; };
        agentClis = [
          agentClisAttrs.opencode
          agentClisAttrs.claude-code
          agentClisAttrs.codex
          agentClisAttrs.amp
          agentClisAttrs.factory-droids
          agentClisAttrs.qwen-code
          agentClisAttrs.gemini-cli
          agentClisAttrs.codex-acp
          agentClisAttrs.github-copilot
          agentClisAttrs.pi
          agentClisAttrs.forge
        ];

        # Kitchen sink across every category.
        allPkgs =
          systemDeps ++ coreCLIs ++ rustDeps ++ jsDeps ++ pythonDeps
          ++ goDeps ++ cppDeps ++ cryptoEvmDeps ++ cryptoL1Deps
          ++ cryptoZkDeps ++ aiDeps ++ mobileDeps ++ dbDeps
          ++ infraDeps ++ observabilityDeps ++ mediaDeps
          ++ languageServers ++ agentClis;

        # `buildEnv` collects every package into a single store path
        # addressable for Cachix push/pull. ignoreCollisions tolerates
        # multiple packages that ship overlapping share/doc dirs.
        mkProfile = name: paths: pkgs.buildEnv {
          name = "ai-trading-blueprint-${name}";
          inherit paths;
          pathsToLink = [ "/bin" "/lib" "/share" "/include" "/etc" ];
          ignoreCollisions = true;
        };
      in
      {
        # ── Dev shells (unchanged surface for local `nix develop`) ─────────
        # `default` keeps the narrow scope this repo's `cargo build`
        # actually needs. `universal` is the kitchen sink for ad-hoc
        # cross-language work.
        devShells.default = pkgs.mkShell {
          name = "blueprint";
          nativeBuildInputs = systemDeps;
          buildInputs = rustDeps ++ cryptoEvmDeps;
          packages = [];
          RUST_SRC_PATH = "${toolchain}/lib/rustlib/src/rust/library";
          LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.gmp pkgs.libclang pkgs.openssl.dev ];
        };
        devShells.universal = pkgs.mkShell {
          name = "blueprint-universal";
          packages = allPkgs;
          RUST_SRC_PATH = "${toolchain}/lib/rustlib/src/rust/library";
          LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.gmp pkgs.libclang pkgs.openssl.dev ];
        };
        # ── Cacheable toolchain profiles (Cachix targets) ──────────────────
        # `packages.universal` is the kitchen-sink closure CI pushes to
        # Cachix. Sub-profiles let downstream jobs pull a narrower
        # closure for faster cold starts on single-language paths.
        packages.default       = mkProfile "universal" allPkgs;
        packages.universal     = mkProfile "universal" allPkgs;
        packages.rust          = mkProfile "rust" (systemDeps ++ coreCLIs ++ rustDeps);
        packages.foundry       = mkProfile "foundry" (systemDeps ++ coreCLIs ++ cryptoEvmDeps);
        packages.js            = mkProfile "js" (coreCLIs ++ jsDeps);
        packages.python        = mkProfile "python" (systemDeps ++ coreCLIs ++ pythonDeps);
        packages.go            = mkProfile "go" (systemDeps ++ coreCLIs ++ goDeps);
        packages.cpp           = mkProfile "cpp" (systemDeps ++ coreCLIs ++ cppDeps);
        packages.crypto        = mkProfile "crypto" (systemDeps ++ coreCLIs ++ cryptoEvmDeps ++ cryptoL1Deps ++ cryptoZkDeps);
        packages.ai            = mkProfile "ai" (systemDeps ++ coreCLIs ++ pythonDeps ++ aiDeps ++ agentClis);
        # Harness profile baked into the blueprint-sidecar image at
        # /nix/profile/bin — opencode/claude-code/codex/qwen/gemini/amp/pi/
        # forge/factory-droids/codex-acp/github-copilot + node runtime.
        # NOTE: no nodejs here — the npm-tarball agent wrappers reference
        # nodejs_22 by absolute store path (it stays in the closure), and
        # putting `node` on /nix/profile/bin would shadow the server base's
        # node (with its node-pty native module) when NIX_BIN_PATH is prepended.
        packages.sidecar-harness = mkProfile "sidecar-harness"
          (agentClis ++ [ pkgs.bash pkgs.coreutils pkgs.cacert ]);
        packages.web           = mkProfile "web" (coreCLIs ++ jsDeps);
        packages.mobile        = mkProfile "mobile" (coreCLIs ++ jsDeps ++ mobileDeps);
        packages.infra         = mkProfile "infra" (coreCLIs ++ infraDeps ++ observabilityDeps);
      });
}
