#!/usr/bin/env sh
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STATIC_DIR="$SCRIPT_DIR/../app/static"
OUT_DIR="$STATIC_DIR/vditor"

mkdir -p "$OUT_DIR"

# Allow override via env, default to 3.10.7
VERSION="${VDITOR_VERSION:-3.10.7}"

# Mirror list (tried in order)
MIRRORS="
https://cdn.jsdelivr.net/npm/vditor@${VERSION}/dist
https://fastly.jsdelivr.net/npm/vditor@${VERSION}/dist
https://unpkg.com/vditor@${VERSION}/dist
"

have_downloader() {
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1
}

download_once() {
  URL="$1"
  OUT="$2"
  mkdir -p "$(dirname "$OUT")"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 8 --max-time 120 "$URL" -o "$OUT" || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=15 --tries=2 -O "$OUT" "$URL" || return 1
  else
    return 1
  fi
}

download_with_mirrors() {
  REL_PATH="$1"
  OUT="$2"
  for BASE in $MIRRORS; do
    URL="$BASE/$REL_PATH"
    echo " - trying: $URL"
    if download_once "$URL" "$OUT" && [ -s "$OUT" ]; then
      return 0
    fi
  done
  return 1
}

if ! have_downloader; then
  echo "Error: need curl or wget to download files" >&2
  exit 1
fi

echo "Downloading Vditor ${VERSION} assets to $OUT_DIR ..."

download_with_mirrors "index.min.js" "$OUT_DIR/index.min.js"
download_with_mirrors "index.css" "$OUT_DIR/index.css"
download_with_mirrors "js/lute/lute.min.js" "$OUT_DIR/js/lute/lute.min.js"

# Fonts referenced by index.css (optional per version)
FONT_DIR="$OUT_DIR/fonts"
mkdir -p "$FONT_DIR"
for F in vditor.woff2 vditor.woff vditor.ttf; do
  if ! download_with_mirrors "fonts/$F" "$FONT_DIR/$F"; then
    echo "(optional font missing or blocked: $F)"
  fi
done

echo "Vditor assets downloaded."


