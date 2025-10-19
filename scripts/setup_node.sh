#!/usr/bin/env bash
set -euo pipefail

FORCE="${FORCE:-false}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_ROOT"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed or not in PATH. Please install Node.js LTS." >&2
  exit 1
fi

if [[ ! -f package.json ]]; then
  echo "[npm] Initializing package.json"
  npm init -y >/dev/null 2>&1
fi

echo "[npm] Installing devDependencies (sass, postcss, autoprefixer, cssnano, stylelint...)"
npm install -D sass postcss postcss-cli autoprefixer cssnano stylelint stylelint-config-standard-scss stylelint-config-prettier >/dev/null 2>&1

POSTCSS_CFG="$REPO_ROOT/postcss.config.js"
if [[ ! -f "$POSTCSS_CFG" || "$FORCE" == "true" ]]; then
  echo "[write] postcss.config.js"
  cat > "$POSTCSS_CFG" <<'EOF'
module.exports = (ctx) => ({
  map: false,
  plugins: {
    autoprefixer: {},
    ...(ctx.env === 'production' ? { cssnano: { preset: 'default' } } : {}),
  },
});
EOF
else
  echo "[skip] postcss.config.js exists (set FORCE=true to overwrite)"
fi

BROWSERSLIST="$REPO_ROOT/.browserslistrc"
if [[ ! -f "$BROWSERSLIST" || "$FORCE" == "true" ]]; then
  echo "[write] .browserslistrc"
  cat > "$BROWSERSLIST" <<'EOF'
> 0.5%
last 2 versions
not dead
EOF
else
  echo "[skip] .browserslistrc exists (set FORCE=true to overwrite)"
fi

echo "Node environment ready. You can run build scripts now."


