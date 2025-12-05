#!/usr/bin/env sh
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

echo "Fetching frontend dependencies (marked, DOMPurify, highlight.js, Vditor) ..."

sh "$SCRIPT_DIR/fetch_marked.sh"
sh "$SCRIPT_DIR/fetch_dompurify.sh"
sh "$SCRIPT_DIR/fetch_highlight.sh"
sh "$SCRIPT_DIR/fetch_vditor.sh"

echo "All frontend dependencies fetched."
