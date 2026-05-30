# Coding-agent CLI derivations — the harnesses the sidecar dispatches to.
#
# Duplicated into this repo (from the shared agent-dev-container recipe) so the
# `blueprint-sidecar` image is SELF-SUFFICIENT: every harness is built once into
# /nix/store and baked into /nix/profile/bin at image-build time. No runtime
# dependence on agent-dev-container or the sandbox SDK — only the shared idea.
#
# SYSTEM-AWARE: binary agents pick their url+sha256 per host platform, so the
# same profile builds on x86_64-linux AND aarch64-linux (the Hetzner box is
# arm64). Pure-JS agents (claude-code, amp, qwen, gemini, pi) are one tarball
# for all arches.
#
# Kinds:
#   - "bare-elf"    → single Linux ELF, no archive (factory-droids, forge)
#   - "bun-sea"     → Bun single-executable: ELF + appended JS bundle (opencode).
#                     Skips autoPatchelfHook + strip — any byte mutation breaks
#                     the bundle's integrity check; relies on the host glibc
#                     loader at runtime.
#   - "npm-tarball" → npm registry .tgz; node wrapper via makeWrapper --add-flags
#
# Bumping: set sha256 = lib.fakeHash, run `nix build .#sidecar-harness`, paste
# the printed hash. For binary agents, prefetch BOTH arches.

{ pkgs }:

let
  lib = pkgs.lib;
  system = pkgs.stdenv.hostPlatform.system;
  # Select a per-system value; throw clearly if a binary agent lacks this arch.
  sel = m: m.${system} or (throw "agent-clis: no artifact for system ${system}");
  # nix system → the arch token upstreams use in archive paths.
  archMusl = sel { "x86_64-linux" = "x86_64-unknown-linux-musl"; "aarch64-linux" = "aarch64-unknown-linux-musl"; };

  mkCliAgent = {
    name,
    version,
    url,
    sha256,
    binary ? name,            # binary name on PATH; defaults to derivation name
    kind ? "bare-elf",
    extraBuildInputs ? [],
    extraNativeBuildInputs ? [],
    postPatch ? "",
    nodeEntry ? null,         # required when kind = "npm-tarball"; e.g. "cli.js"
    description ? null,
    license ? lib.licenses.unfree,
  }:
    assert (kind == "npm-tarball") -> (nodeEntry != null);
    pkgs.stdenvNoCC.mkDerivation {
      pname = name;
      inherit version;
      src = pkgs.fetchurl { inherit url sha256; };

      nativeBuildInputs =
        lib.optional (kind == "tar-elf" || kind == "zip-elf" || kind == "bare-elf") pkgs.autoPatchelfHook
        ++ lib.optional (kind == "zip-elf") pkgs.unzip
        ++ lib.optional (kind == "npm-tarball") pkgs.makeWrapper
        ++ extraNativeBuildInputs;

      buildInputs =
        lib.optionals (kind == "tar-elf" || kind == "zip-elf" || kind == "bare-elf")
          [ pkgs.stdenv.cc.cc.lib pkgs.openssl pkgs.zlib ]
        ++ lib.optional (kind == "npm-tarball") pkgs.nodejs_22
        ++ extraBuildInputs;

      dontUnpack = kind == "bare-elf";
      dontPatchELF = kind == "bun-sea";
      dontStrip    = kind == "bun-sea";
      sourceRoot = if kind == "npm-tarball" then "package" else ".";

      unpackPhase =
        if kind == "bare-elf" then "true"
        else if kind == "tar-elf" then "tar xzf $src"
        else if kind == "zip-elf" then "unzip $src"
        else if kind == "bun-sea" then "tar xzf $src"
        else if kind == "npm-tarball" then "tar xzf $src"
        else throw "mkCliAgent: unknown kind '${kind}'";

      inherit postPatch;

      installPhase =
        if kind == "npm-tarball" then ''
          mkdir -p $out/lib/node_modules/${name} $out/bin
          cp -r . $out/lib/node_modules/${name}/
          makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/${binary} \
            --add-flags $out/lib/node_modules/${name}/${nodeEntry}
        ''
        else if kind == "bare-elf" then ''
          install -Dm755 $src $out/bin/${binary}
        ''
        else ''
          install -Dm755 ${binary} $out/bin/${binary}
        '';

      meta = {
        inherit license;
        description = if description != null then description else "Agent CLI: ${name}";
        mainProgram = binary;
        platforms = [ "x86_64-linux" "aarch64-linux" ];
      };
    };

in {
  inherit mkCliAgent;

  # ─── Anthropic Claude Code (pure JS, arch-independent) ─────────────────────
  claude-code = mkCliAgent {
    name = "claude-code";
    binary = "claude";
    version = "2.1.63";
    url = "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.63.tgz";
    sha256 = "sha256-eHztBWax0Rp5AMuSJvd9Kv5dAiueu6hef9XNB758unc=";
    kind = "npm-tarball";
    nodeEntry = "cli.js";
    description = "Anthropic Claude Code CLI — agent that reads and edits code.";
  };

  # ─── OpenAI Codex (per-arch native binary) ────────────────────────────────
  codex = pkgs.stdenvNoCC.mkDerivation {
    pname = "codex";
    version = "0.122.0";
    src = pkgs.fetchurl {
      url = sel {
        "x86_64-linux"  = "https://registry.npmjs.org/@openai/codex/-/codex-0.122.0-linux-x64.tgz";
        "aarch64-linux" = "https://registry.npmjs.org/@openai/codex/-/codex-0.122.0-linux-arm64.tgz";
      };
      sha256 = sel {
        "x86_64-linux"  = "sha256-rGn4lJbQPhIpj8YK+GBTRTGwAdwEDAsXlQLj1YcolCY=";
        "aarch64-linux" = "sha256-eab+yrHwVydLJp5PPL6eKfaOL/DCi348iON1jDPxgys=";
      };
    };
    nativeBuildInputs = [ pkgs.makeWrapper ];
    sourceRoot = "package";
    unpackPhase = "tar xzf $src";
    installPhase = ''
      codexRoot="$out/lib/codex/vendor/${archMusl}"
      mkdir -p "$codexRoot" "$out/bin"
      cp -r vendor/${archMusl}/* "$codexRoot/"
      chmod -R u+w "$out/lib/codex"
      makeWrapper "$codexRoot/codex/codex" "$out/bin/codex" \
        --prefix PATH : "$codexRoot/path"
    '';
    meta = {
      description = "OpenAI Codex CLI.";
      mainProgram = "codex";
      license = lib.licenses.asl20;
      platforms = [ "x86_64-linux" "aarch64-linux" ];
    };
  };

  # ─── Sourcegraph AMP (pure JS) ─────────────────────────────────────────────
  amp = mkCliAgent {
    name = "amp";
    version = "0.0.1772380903-g3d33e9";
    url = "https://registry.npmjs.org/@sourcegraph/amp/-/amp-0.0.1772380903-g3d33e9.tgz";
    sha256 = "sha256-et75i0FKiJ9LUtLO6JJw2vcPtR8gTIuCyyK0k73PmUk=";
    kind = "npm-tarball";
    nodeEntry = "bin/amp.js";
    description = "Sourcegraph AMP CLI.";
    postPatch = ''
      for f in bin/amp bin/amp.js; do
        if [ -f "$f" ]; then
          sed -i '1s|^#!/usr/bin/env -S node --no-warnings$|#!/usr/bin/env node|' "$f"
        fi
      done
    '';
  };

  # ─── Factory Droids (per-arch bare ELF) ───────────────────────────────────
  factory-droids = mkCliAgent {
    name = "factory-droids";
    binary = "droid";
    version = "0.65.0";
    url = sel {
      "x86_64-linux"  = "https://downloads.factory.ai/factory-cli/releases/0.65.0/linux/x64-baseline/droid";
      "aarch64-linux" = "https://downloads.factory.ai/factory-cli/releases/0.65.0/linux/arm64/droid";
    };
    sha256 = sel {
      "x86_64-linux"  = "sha256-hbH2OcK364tAInbSMBaTzoVDuS9xpjkS4F8v4CuF6GM=";
      "aarch64-linux" = "sha256-fVg6tL+YcsRT/GNDpPzosfVxcGPXGCLc9Lm2WAQmsHc=";
    };
    kind = "bare-elf";
    description = "Factory.ai Droid coding agent CLI.";
  };

  # ─── OpenCode (anomalyco) — per-arch Bun single-executable ────────────────
  opencode = mkCliAgent {
    name = "opencode";
    version = "1.14.20";
    url = sel {
      "x86_64-linux"  = "https://github.com/anomalyco/opencode/releases/download/v1.14.20/opencode-linux-x64.tar.gz";
      "aarch64-linux" = "https://github.com/anomalyco/opencode/releases/download/v1.14.20/opencode-linux-arm64.tar.gz";
    };
    sha256 = sel {
      "x86_64-linux"  = "sha256-FwcTMCI4LqjIzFvEerHbUvoga9m6+NOtTYYrSJ27RI8=";
      "aarch64-linux" = "sha256-PKUJBE4GuOfazwjec1rd7kAHiPgHKcMz+/RYHQ93tNM=";
    };
    kind = "bun-sea";
    description = "OpenCode multi-provider coding agent (anomalyco).";
  };

  # ─── Qwen Code (pure JS) ──────────────────────────────────────────────────
  qwen-code = mkCliAgent {
    name = "qwen-code";
    binary = "qwen";
    version = "0.14.5";
    url = "https://registry.npmjs.org/@qwen-code/qwen-code/-/qwen-code-0.14.5.tgz";
    sha256 = "sha256-IB+R9G/pwYbCbDPsRcq0iuFNiRYExf9YD4d/xbD7slU=";
    kind = "npm-tarball";
    nodeEntry = "cli.js";
    description = "Qwen Code — QwenLM/Alibaba coding agent CLI.";
  };

  # ─── GitHub Copilot CLI (per-arch native binary) ──────────────────────────
  github-copilot = pkgs.stdenv.mkDerivation {
    pname = "github-copilot";
    version = "1.0.32";
    src = pkgs.fetchurl {
      url = sel {
        "x86_64-linux"  = "https://registry.npmjs.org/@github/copilot-linux-x64/-/copilot-linux-x64-1.0.32.tgz";
        "aarch64-linux" = "https://registry.npmjs.org/@github/copilot-linux-arm64/-/copilot-linux-arm64-1.0.32.tgz";
      };
      sha256 = sel {
        "x86_64-linux"  = "sha256-AHsWdTkcpsUSfNyyzY3xCvJIMZjDhNLMpMoje7VW5iM=";
        "aarch64-linux" = "sha256-xfpImsQIVqwlWfeKLsMgUToBtpYzQ4BAhgbFDGEQ/2w=";
      };
    };
    dontPatchELF = true;
    dontStrip = true;
    sourceRoot = "package";
    unpackPhase = "tar xzf $src";
    installPhase = ''
      mkdir -p $out/bin
      install -Dm755 copilot $out/bin/copilot
    '';
    meta = {
      description = "GitHub Copilot CLI (terminal-native AI agent).";
      mainProgram = "copilot";
      license = lib.licenses.unfree;
      platforms = [ "x86_64-linux" "aarch64-linux" ];
    };
  };

  # ─── Google Gemini CLI (pure JS) ──────────────────────────────────────────
  gemini-cli = mkCliAgent {
    name = "gemini-cli";
    binary = "gemini";
    version = "0.38.2";
    url = "https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-0.38.2.tgz";
    sha256 = "sha256-mwx1LP6TdTcOGBLzev/9lzh7md9x5kzqU+WIol9NaIw=";
    kind = "npm-tarball";
    nodeEntry = "bundle/gemini.js";
    description = "Google Gemini CLI (also serves ACP via `gemini acp`).";
  };

  # ─── Zed codex-acp (per-arch Rust binary) ─────────────────────────────────
  codex-acp = pkgs.stdenv.mkDerivation {
    pname = "codex-acp";
    version = "0.11.1";
    src = pkgs.fetchurl {
      url = sel {
        "x86_64-linux"  = "https://registry.npmjs.org/@zed-industries/codex-acp-linux-x64/-/codex-acp-linux-x64-0.11.1.tgz";
        "aarch64-linux" = "https://registry.npmjs.org/@zed-industries/codex-acp-linux-arm64/-/codex-acp-linux-arm64-0.11.1.tgz";
      };
      sha256 = sel {
        "x86_64-linux"  = "sha256-BRzBwbYyeXtltXTjGz7rqguHlWOaMIDJNxC5Z1XmK+M=";
        "aarch64-linux" = "sha256-DsdfHNC9YBG2h9CqwlR48xI/+oHsKZKBvLF0fdMWLio=";
      };
    };
    nativeBuildInputs = [ pkgs.autoPatchelfHook ];
    # xz provides liblzma.so.5 — the aarch64 codex-acp binary links it.
    buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.libcap pkgs.openssl pkgs.zlib pkgs.xz ];
    sourceRoot = "package";
    unpackPhase = "tar xzf $src";
    installPhase = ''
      mkdir -p $out/bin
      install -Dm755 bin/codex-acp $out/bin/codex-acp
    '';
    meta = {
      description = "Zed's ACP-compatible wrapper around OpenAI Codex CLI.";
      mainProgram = "codex-acp";
      license = lib.licenses.unfree;
      platforms = [ "x86_64-linux" "aarch64-linux" ];
    };
  };

  # ─── Pi Coding Agent (pure JS) ────────────────────────────────────────────
  pi = mkCliAgent {
    name = "pi";
    version = "0.67.68";
    url = "https://registry.npmjs.org/@mariozechner/pi-coding-agent/-/pi-coding-agent-0.67.68.tgz";
    sha256 = "sha256-C2T+IeIiHhXAy5TJ3/1c+7mQGumd9BanHF2RWm6eFxc=";
    kind = "npm-tarball";
    nodeEntry = "dist/cli.js";
    description = "Pi Coding Agent (Mario Zechner / pi-mono).";
  };

  # ─── Forge (tailcallhq, per-arch bare ELF) ────────────────────────────────
  # Bin renamed `forgecode` to avoid colliding with Foundry's solidity `forge`.
  forge = mkCliAgent {
    name = "forge";
    binary = "forgecode";
    version = "2.11.4";
    url = sel {
      "x86_64-linux"  = "https://github.com/tailcallhq/forgecode/releases/download/v2.11.4/forge-x86_64-unknown-linux-gnu";
      "aarch64-linux" = "https://github.com/tailcallhq/forgecode/releases/download/v2.11.4/forge-aarch64-unknown-linux-gnu";
    };
    sha256 = sel {
      "x86_64-linux"  = "sha256-BGqtXmYhWWb/6Ft7vGxSbHYPuCkTpClCfrCYH+aGEAo=";
      "aarch64-linux" = "sha256-XdCnapJQYwUxtuNM9SyENmfOezs0TU0bbIMQbgv7SMc=";
    };
    kind = "bare-elf";
    description = "Forge coding agent (tailcallhq/forgecode) — multi-provider, shell-integrated.";
    license = lib.licenses.asl20;
  };
}
