#!/usr/bin/env bash
# generate-sbom.sh — emit a CycloneDX SBOM for the workspace.
#
# We use cargo-cyclonedx (https://github.com/CycloneDX/cyclonedx-rust-cargo)
# because it understands the cargo workspace shape and emits CycloneDX
# 1.5 JSON, which is the format consumed by Anchore Grype / Trivy /
# OWASP Dependency-Track.
#
# Output: audits/sbom.cdx.json
#
# When to run:
# - Before every release PR. Commit the resulting SBOM alongside the
#   lockfile so the release tag pins both the source dependencies and
#   the SBOM that was scanned.
# - When a major upstream dep upgrade lands (Solana/Alloy major bumps),
#   to refresh the licence + version inventory.
#
# This script is **not** invoked by CI by default — generating the
# SBOM requires network access to fetch crate metadata, and CI's
# advisory check (`cargo deny`) already covers the scan-on-every-PR
# requirement. Treat the SBOM as an artefact of release engineering,
# not a per-commit gate.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SBOM_PATH="${REPO_ROOT}/audits/sbom.cdx.json"

cd "${REPO_ROOT}"

# Idempotent install. `--locked` ensures cargo-cyclonedx itself
# resolves against its own pinned lockfile, so re-runs on different
# machines produce the same generator binary.
if ! command -v cargo-cyclonedx >/dev/null 2>&1; then
    echo "==> Installing cargo-cyclonedx (idempotent)..."
    cargo install cargo-cyclonedx --locked
fi

# `--all` emits a per-crate SBOM stream; we collapse to a single
# top-level CDX JSON for `audits/sbom.cdx.json`. `--format json` is
# the CycloneDX JSON profile (vs the default XML).
echo "==> Generating CycloneDX SBOM..."
cargo cyclonedx \
    --format json \
    --all-features \
    --output-pattern bom \
    --output-cdx \
    --target-in-filename=false

# cargo-cyclonedx writes one file per workspace member next to its
# Cargo.toml. Concatenate the workspace-root one into the canonical
# audits/ location so reviewers and release tooling have a single
# path to look at.
ROOT_BOM="${REPO_ROOT}/bom.cdx.json"
if [[ ! -f "${ROOT_BOM}" ]]; then
    echo "ERROR: cargo-cyclonedx did not emit ${ROOT_BOM}" >&2
    exit 1
fi

mkdir -p "$(dirname "${SBOM_PATH}")"
mv "${ROOT_BOM}" "${SBOM_PATH}"

# Clean up the per-crate stragglers so they don't pollute the tree.
find "${REPO_ROOT}" -maxdepth 3 -name 'bom.cdx.json' -not -path "${SBOM_PATH}" -delete

echo "==> SBOM written to ${SBOM_PATH}"
echo "    Components: $(jq '.components | length' "${SBOM_PATH}" 2>/dev/null || echo 'install jq for component count')"
echo "    Spec version: $(jq -r '.specVersion' "${SBOM_PATH}" 2>/dev/null || echo 'unknown')"
