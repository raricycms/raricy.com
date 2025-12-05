#!/usr/bin/env sh
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
JS_DIR="$SCRIPT_DIR/../app/static/js"
CSS_DIR="$SCRIPT_DIR/../app/static/css/hljs"
JS_OUT="$JS_DIR/highlight.min.js"
CSS_LIGHT="$CSS_DIR/default.min.css"
CSS_DARK="$CSS_DIR/monokai.min.css"

URL_JS="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"
URL_LIGHT="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/default.min.css"
URL_DARK="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/monokai.min.css"

mkdir -p "$JS_DIR" "$CSS_DIR"

download() {
  URL="$1"
  OUT="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$OUT"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$OUT" "$URL"
  else
    echo "Error: need curl or wget to download files" >&2
    exit 1
  fi
}

echo "Downloading highlight.js and CSS..."
download "$URL_JS" "$JS_OUT"
download "$URL_LIGHT" "$CSS_LIGHT"
download "$URL_DARK" "$CSS_DARK"

[ -s "$JS_OUT" ] || { echo "highlight.min.js download failed" >&2; exit 1; }
[ -s "$CSS_LIGHT" ] || { echo "default.min.css download failed" >&2; exit 1; }
[ -s "$CSS_DARK" ] || { echo "monokai.min.css download failed" >&2; exit 1; }

echo "Done."
