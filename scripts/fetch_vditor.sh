#!/usr/bin/env sh
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STATIC_DIR="$SCRIPT_DIR/../app/static"
OUT_DIR="$STATIC_DIR/vditor"

mkdir -p "$OUT_DIR"

# Version can be bumped as needed
VERSION="3.10.7"
BASE="https://cdn.jsdelivr.net/npm/vditor@${VERSION}/dist"

download() {
  URL="$1"
  OUT="$2"
  mkdir -p "$(dirname "$OUT")"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$OUT"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$OUT" "$URL"
  else
    echo "Error: need curl or wget to download files" >&2
    exit 1
  fi
}

echo "Downloading Vditor ${VERSION} assets to $OUT_DIR ..."

download "$BASE/index.min.js" "$OUT_DIR/index.min.js"
download "$BASE/index.css" "$OUT_DIR/index.css"
download "$BASE/js/lute/lute.min.js" "$OUT_DIR/lute.min.js"

# Fonts referenced by index.css (optional per version)
FONT_DIR="$OUT_DIR/fonts"
mkdir -p "$FONT_DIR"
for F in vditor.woff2 vditor.woff vditor.ttf; do
  URL="$BASE/fonts/$F"
  OUT="$FONT_DIR/$F"
  if ! download "$URL" "$OUT" 2>/dev/null; then
    echo "(optional font missing: $F)"
  fi
done

echo "Vditor assets downloaded."


