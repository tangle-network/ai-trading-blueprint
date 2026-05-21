#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
npm run eval:trading-personas -- "$@"
