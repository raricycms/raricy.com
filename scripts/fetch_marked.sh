#!/usr/bin/env sh
set -euo pipefail

# Resolve script directory
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT_DIR="$SCRIPT_DIR/../app/static/js"
OUT_FILE="$OUT_DIR/marked.min.js"
URL="https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js"

mkdir -p "$OUT_DIR"

# Choose downloader
if command -v curl >/dev/null 2>&1; then
  echo "Downloading with curl..."
  curl -fsSL "$URL" -o "$OUT_FILE"
elif command -v wget >/dev/null 2>&1; then
  echo "Downloading with wget..."
  wget -qO "$OUT_FILE" "$URL"
else
  echo "Error: need curl or wget to download marked.min.js" >&2
  exit 1
fi

if [ ! -s "$OUT_FILE" ]; then
  echo "Error: download failed or empty file: $OUT_FILE" >&2
  exit 1
fi

SIZE=$(wc -c < "$OUT_FILE" | tr -d ' ')
printf "Done. Size: %s bytes\n" "$SIZE"
