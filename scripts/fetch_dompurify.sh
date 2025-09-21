#!/usr/bin/env sh
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT_DIR="$SCRIPT_DIR/../app/static/js"
OUT_FILE="$OUT_DIR/dompurify.min.js"
URL="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js"

mkdir -p "$OUT_DIR"

if command -v curl >/dev/null 2>&1; then
  echo "Downloading DOMPurify with curl..."
  curl -fsSL "$URL" -o "$OUT_FILE"
elif command -v wget >/dev/null 2>&1; then
  echo "Downloading DOMPurify with wget..."
  wget -qO "$OUT_FILE" "$URL"
else
  echo "Error: need curl or wget to download dompurify.min.js" >&2
  exit 1
fi

if [ ! -s "$OUT_FILE" ]; then
  echo "Error: download failed or empty file: $OUT_FILE" >&2
  exit 1
fi

SIZE=$(wc -c < "$OUT_FILE" | tr -d ' ')
printf "Done. Size: %s bytes\n" "$SIZE"
