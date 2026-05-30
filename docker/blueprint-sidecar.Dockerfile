# blueprint-sidecar:all-harness — the sandbox sidecar image, owned by THIS repo.
#
# Self-sufficient: the coding-agent harnesses (opencode, claude-code, codex,
# qwen, gemini, amp, pi, forge, factory-droids, codex-acp, github-copilot) are
# built from this repo's own Nix profile (nix/agent-clis.nix → flake output
# `.#sidecar-harness`) and baked into /nix/profile/bin. No runtime dependence on
# the upstream sandbox tooling or SDK — only the shared recipe.
#
# The agent server (the Hono app at /sidecar/server.js that serves /agents/run,
# exec, /terminals) comes from SERVER_BASE — a pinned, owned artifact. The
# sidecar's process manager already prepends NIX_BIN_PATH=/nix/profile/bin to
# PATH, so dropping the harness closure there is all that's needed for the agent
# to resolve `opencode` (the bug: the old image had an empty /nix/profile/bin).
#
# Build (on a host with docker + the SERVER_BASE image present):
#   docker build -f docker/blueprint-sidecar.Dockerfile \
#     --build-arg SERVER_BASE=blueprint-sidecar-base:pinned \
#     -t blueprint-sidecar:all-harness .
#
# Stage 1 runs nix INSIDE the container, so the build host needs only docker.

# Global ARG (declared before the first FROM) so it's usable in stage 2's FROM.
ARG SERVER_BASE=blueprint-sidecar-base:pinned

# ── Stage 1: build this repo's harness Nix profile + export its closure ──────
FROM nixos/nix:2.24.10 AS harness-builder

# Cachix + cache.nixos.org so the ~1.2 GB closure resolves from cache instead of
# rebuilding from source. Keys match flake.nix nixConfig.
RUN { echo 'experimental-features = nix-command flakes'; \
      echo 'substituters = https://cache.nixos.org https://tangle-sandbox.cachix.org'; \
      echo 'trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY= tangle-sandbox.cachix.org-1:Phh3AbYMAfvfAHAkxKyRXuLPgPlbA2BJ+u3AKTL5JPM='; \
    } >> /etc/nix/nix.conf

WORKDIR /flake
# Copy only the flake-relevant files (no .git → path flake → all files visible
# without git-tracking gymnastics).
COPY flake.nix flake.lock rust-toolchain.toml ./
COPY nix ./nix

# Realize the harness profile and export its full runtime closure to /export so
# stage 2 can COPY a self-contained /nix subtree (not the builder's whole store).
RUN nix build --accept-flake-config '.#sidecar-harness' --out-link /tmp/result && \
    mkdir -p /export/nix/store && \
    for p in $(nix-store -qR "$(readlink -f /tmp/result)"); do cp -a "$p" /export/nix/store/; done && \
    cp -a "$(readlink -f /tmp/result)" /export/profile && \
    echo "harnesses:" && ls /export/profile/bin | sort

# ── Stage 2: bake the harness closure over the owned server base ─────────────
FROM ${SERVER_BASE}

# /nix/store holds the agent binaries + their full closure (node, glibc, …);
# /nix/profile/bin holds the symlinks the server's NIX_BIN_PATH prepend resolves.
COPY --from=harness-builder /export/nix/store /nix/store
COPY --from=harness-builder /export/profile /nix/profile

# Only set NIX_BIN_PATH — the server's process manager prepends it to PATH when
# spawning agents. Do NOT prepend it to the image PATH globally: that would put
# the Nix node ahead of the base image's node (which carries the server's
# node-pty native module), breaking `node server.js` + PTY/terminal ops.
ENV NIX_BIN_PATH=/nix/profile/bin

# ENTRYPOINT/CMD (tini -- node server.js, port 8080) inherited from SERVER_BASE.
