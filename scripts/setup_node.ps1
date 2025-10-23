Param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $RepoRoot
try {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is not installed or not in PATH. Please install Node.js LTS."
  }

  if (-not (Test-Path 'package.json')) {
    Write-Host "[npm] Initializing package.json" -ForegroundColor Cyan
    & npm init -y | Out-Null
  }

  Write-Host "[npm] Installing devDependencies (sass, postcss, autoprefixer, cssnano, stylelint...)" -ForegroundColor Cyan
  & npm install -D sass postcss postcss-cli autoprefixer cssnano stylelint stylelint-config-standard-scss stylelint-config-prettier | Out-Null

  $postcssPath = Join-Path $RepoRoot 'postcss.config.js'
  if (-not (Test-Path $postcssPath) -or $Force.IsPresent) {
    Write-Host "[write] postcss.config.js" -ForegroundColor Cyan
    @"
module.exports = (ctx) => ({
  map: false,
  plugins: {
    autoprefixer: {},
    ...(ctx.env === 'production' ? { cssnano: { preset: 'default' } } : {}),
  },
});
"@ | Set-Content -Encoding UTF8 $postcssPath
  } else {
    Write-Host "[skip] postcss.config.js exists (use -Force to overwrite)" -ForegroundColor Yellow
  }

  $browserslistPath = Join-Path $RepoRoot '.browserslistrc'
  if (-not (Test-Path $browserslistPath) -or $Force.IsPresent) {
    Write-Host "[write] .browserslistrc" -ForegroundColor Cyan
    @">
> 0.5%
last 2 versions
not dead
"@ | Set-Content -Encoding UTF8 $browserslistPath
  } else {
    Write-Host "[skip] .browserslistrc exists (use -Force to overwrite)" -ForegroundColor Yellow
  }

  Write-Host "Node environment ready. You can run build scripts now." -ForegroundColor Green
}
finally {
  Pop-Location
}


