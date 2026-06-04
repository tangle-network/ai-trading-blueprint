#!/usr/bin/env bash
set -euo pipefail

BINARIES_DEFAULT="trading-blueprint trading-instance-blueprint trading-tee-instance-blueprint trading-validator"
BINARIES="${BINARIES:-$BINARIES_DEFAULT}"
TARGET="${TARGET:-x86_64-unknown-linux-gnu}"
OUT_ROOT="${OUT_ROOT:-.evolve/local-release-artifacts}"
TAG=""
OUT_DIR=""
UPLOAD=false
NO_BUILD=false

usage() {
  cat <<'USAGE'
Build and package release artifacts from the local machine.

Usage:
  scripts/release-local-artifacts.sh [--tag vX.Y.Z] [--out-dir PATH] [--target TRIPLE] [--no-build] [--upload]

Options:
  --tag TAG        Release tag. Defaults to the exact current git tag, then local-<sha>.
  --out-dir PATH   Output directory. Defaults to .evolve/local-release-artifacts/<tag>-<target>.
  --target TRIPLE  Cargo target/asset triple. Defaults to x86_64-unknown-linux-gnu.
  --no-build       Package existing target artifacts without running cargo build.
  --upload         Upload artifacts to the GitHub Release for --tag. Requires a non-local tag.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:?missing value for --tag}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:?missing value for --out-dir}"
      shift 2
      ;;
    --target)
      TARGET="${2:?missing value for --target}"
      shift 2
      ;;
    --no-build)
      NO_BUILD=true
      shift
      ;;
    --upload)
      UPLOAD=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TAG" ]]; then
  TAG="$(git describe --tags --exact-match 2>/dev/null || true)"
fi
if [[ -z "$TAG" ]]; then
  TAG="local-$(git rev-parse --short HEAD)"
fi

if [[ "$UPLOAD" == true && "$TAG" == local-* ]]; then
  echo "--upload requires --tag with a real release tag, not $TAG" >&2
  exit 2
fi

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$OUT_ROOT/$TAG-$TARGET"
fi

HOST="$(rustc -Vv | awk '/^host:/ {print $2}')"
if [[ "$TARGET" == "$HOST" ]]; then
  RELEASE_DIR="target/release"
  CARGO_TARGET_ARGS=()
else
  RELEASE_DIR="target/$TARGET/release"
  CARGO_TARGET_ARGS=(--target "$TARGET")
fi

if command -v sccache >/dev/null 2>&1 && [[ -z "${RUSTC_WRAPPER:-}" ]]; then
  export RUSTC_WRAPPER=sccache
  sccache --start-server >/dev/null 2>&1 || true
fi

if [[ -z "${TRADING_RELEASE_DISABLE_FAST_LINKER:-}" ]]; then
  FAST_LINKER=""
  if command -v mold >/dev/null 2>&1; then
    FAST_LINKER=mold
  elif command -v ld.lld >/dev/null 2>&1; then
    FAST_LINKER=lld
  fi
  if [[ -n "$FAST_LINKER" && "${RUSTFLAGS:-}" != *"fuse-ld="* ]]; then
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=$FAST_LINKER"
  fi
fi

start_s="$(date +%s)"

if [[ "$NO_BUILD" == false ]]; then
  cargo_args=(build --release "${CARGO_TARGET_ARGS[@]}")
  for binary in $BINARIES; do
    cargo_args+=(--bin "$binary")
  done
  cargo "${cargo_args[@]}"
fi

tmp_root="$(mktemp -d)"
out_tmp="$OUT_DIR.tmp"
trap 'rm -rf "$tmp_root" "$out_tmp"' EXIT
rm -rf "$out_tmp"
mkdir -p "$tmp_root/bin" "$out_tmp"

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
if [[ -z "$repo" ]]; then
  repo="$(git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
fi
base_url="https://github.com/$repo/releases/download/$TAG"

manifest_artifacts=""
for binary in $BINARIES; do
  src="$RELEASE_DIR/$binary"
  if [[ ! -f "$src" ]]; then
    echo "missing binary: $src" >&2
    exit 1
  fi

  cp "$src" "$tmp_root/bin/$binary"
  strip "$tmp_root/bin/$binary" 2>/dev/null || true

  archive="$out_tmp/${binary}-${TARGET}.tar.xz"
  tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -cJf "$archive" -C "$tmp_root/bin" "$binary"
  tar_sha="$(sha256sum "$archive" | awk '{print $1}')"
  printf '%s  %s\n' "$tar_sha" "$(basename "$archive")" > "${archive}.sha256"
  sha256sum "$tmp_root/bin/$binary" | awk '{print $1}' > "$out_tmp/${binary}-${TARGET}.bin.sha256"

  case "$TARGET" in
    *x86_64*) arch=x86_64 ;;
    *aarch64*) arch=aarch64 ;;
    *) arch="$TARGET" ;;
  esac

  printf '{"schema":"tangle-binary-manifest/v1","blueprint":"%s","version":"%s","binaries":[{"os":"linux","arch":"%s","url":"%s/%s","sha256":"%s"}]}\n' \
    "$binary" "$TAG" "$arch" "$base_url" "$(basename "$archive")" "$tar_sha" \
    > "$out_tmp/${binary}-manifest.json"

  manifest_artifacts="${manifest_artifacts}\"${binary}\":{\"kind\":\"executable-zip\",\"assets\":[{\"name\":\"${binary}\",\"kind\":\"executable\"}]},"
done

manifest_artifacts="${manifest_artifacts%,}"
printf '{"artifacts":{%s}}\n' "$manifest_artifacts" > "$out_tmp/dist-manifest.json"

rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
mv "$out_tmp" "$OUT_DIR"

if [[ "$UPLOAD" == true ]]; then
  gh release view "$TAG" >/dev/null 2>&1 \
    || gh release create "$TAG" --title "$TAG" --notes "Operator binaries: $BINARIES"

  for file in "$OUT_DIR"/*; do
    name="$(basename "$file")"
    if gh release view "$TAG" --json assets --jq ".assets[] | select(.name == \"$name\") | .name" | grep -qx "$name"; then
      existing_dir="$(mktemp -d)"
      gh release download "$TAG" --pattern "$name" --dir "$existing_dir"
      if cmp -s "$file" "$existing_dir/$name"; then
        echo "asset already exists unchanged: $name"
      else
        echo "release asset already exists with different bytes: $name" >&2
        exit 1
      fi
      rm -rf "$existing_dir"
    else
      gh release upload "$TAG" "$file"
    fi
  done
fi

elapsed_s="$(( $(date +%s) - start_s ))"
echo "release artifacts ready: $OUT_DIR (${elapsed_s}s)"
find "$OUT_DIR" -maxdepth 1 -type f -printf '%f\n' | sort

if [[ "${RUSTC_WRAPPER:-}" == *sccache* ]]; then
  sccache --show-stats || true
fi
