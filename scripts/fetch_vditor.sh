#!/usr/bin/env sh
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STATIC_DIR="$SCRIPT_DIR/../app/static"
PKG_DIR="$STATIC_DIR/js/vditor"

echo "Installing Vditor via npm into $PKG_DIR ..."

mkdir -p "$PKG_DIR"

# Prefer npm, fallback to pnpm/yarn if provided via env
RUNNER="${NPM_RUNNER:-npm}"
if ! command -v "$RUNNER" >/dev/null 2>&1; then
  echo "Error: $RUNNER not found. Set NPM_RUNNER to a valid package manager (npm/pnpm/yarn)." >&2
  exit 1
fi

cd "$PKG_DIR"
if [ ! -f package.json ]; then
  "$RUNNER" init -y >/dev/null 2>&1 || true
fi

# Allow override version
VDITOR_VERSION="${VDITOR_VERSION:-latest}"

"$RUNNER" install vditor@"$VDITOR_VERSION" --save --silent --no-audit --no-fund

DIST_DIR="$PKG_DIR/node_modules/vditor/dist"
if [ ! -d "$DIST_DIR" ]; then
  echo "Error: Vditor dist not found at $DIST_DIR" >&2
  exit 1
fi

echo "Vditor installed at $DIST_DIR"


