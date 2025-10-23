#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-dev}"
WATCH="${WATCH:-false}"
TO_MAIN="${TO_MAIN:-false}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCSS_FILE="$REPO_ROOT/app/static/scss/main.scss"
SCSS_DIR="$REPO_ROOT/app/static/scss"
CSS_DIR="$REPO_ROOT/app/static/css"
CSS_FILE="$CSS_DIR/main.css"
AUTO_FILE="$CSS_DIR/main.autopref.css"
MIN_FILE="$CSS_DIR/main.min.css"

mkdir -p "$CSS_DIR"

if [[ ! -f "$SCSS_FILE" ]]; then
  echo "SCSS entry not found: $SCSS_FILE" >&2
  exit 1
fi

if [[ "$MODE" == "dev" ]]; then
  echo "[Sass] Building (dev) → $CSS_FILE"
  if [[ "$WATCH" == "true" ]]; then
    npx --yes sass --style=expanded --source-map "$SCSS_FILE" "$CSS_FILE" --load-path="$SCSS_DIR" --watch
  else
    npx --yes sass --style=expanded --source-map "$SCSS_FILE" "$CSS_FILE" --load-path="$SCSS_DIR"
  fi
  exit $?
fi

if [[ "$MODE" == "prod" ]]; then
  echo "[Sass] Compiling (prod) → $CSS_FILE"
  npx --yes sass --style=expanded "$SCSS_FILE" "$CSS_FILE" --no-source-map --load-path="$SCSS_DIR"

  echo "[PostCSS] Autoprefix → $AUTO_FILE"
  npx --yes --package postcss-cli --package autoprefixer postcss "$CSS_FILE" --use autoprefixer --no-map -o "$AUTO_FILE"

  echo "[PostCSS] Minify → $MIN_FILE"
  npx --yes --package postcss-cli --package cssnano postcss "$AUTO_FILE" --use cssnano --no-map -o "$MIN_FILE"

  rm -f "$AUTO_FILE"
  if [[ "$TO_MAIN" == "true" ]]; then
    cp "$MIN_FILE" "$CSS_FILE"
    echo "Done. Wrote minified CSS to main.css for production use."
  else
    echo "Done. Use main.min.css in production."
  fi
  exit 0
fi

echo "Unknown mode: $MODE (use 'dev' or 'prod')" >&2
exit 2


