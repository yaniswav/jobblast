#!/usr/bin/env bash
# Production build for JobBlast: typecheck, build the frontend (jobblast),
# then build the API server bundle. Fails loudly (non-zero exit) on the
# first error.
#
# Usage: bash deploy/build.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/3] pnpm run typecheck"
pnpm run typecheck

echo "==> [2/3] Building frontend (@workspace/jobblast, BASE_PATH=/)"
BASE_PATH=/ pnpm --filter @workspace/jobblast run build

echo "==> [3/3] Building API server (@workspace/api-server)"
pnpm --filter @workspace/api-server run build

echo "==> Build succeeded."
