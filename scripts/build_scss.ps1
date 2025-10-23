Param(
  [ValidateSet('dev','prod')]
  [string]$Mode = 'dev',
  [switch]$Watch,
  [switch]$ToMain
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent
$ScssFile = Join-Path $RepoRoot 'app/static/scss/main.scss'
$ScssDir  = Join-Path $RepoRoot 'app/static/scss'
$CssDir   = Join-Path $RepoRoot 'app/static/css'
$CssFile  = Join-Path $CssDir  'main.css'
$AutoFile = Join-Path $CssDir  'main.autopref.css'
$MinFile  = Join-Path $CssDir  'main.min.css'

if (!(Test-Path $ScssFile)) {
  Write-Error "SCSS entry not found: $ScssFile"
}

New-Item -ItemType Directory -Path $CssDir -Force | Out-Null

if ($Mode -eq 'dev') {
  if ($Watch.IsPresent) {
    Write-Host "[Sass] Building (dev, watch) → $CssFile" -ForegroundColor Cyan
    & npx --yes sass --style=expanded --source-map $ScssFile $CssFile --load-path=$ScssDir --watch
  } else {
    Write-Host "[Sass] Building (dev) → $CssFile" -ForegroundColor Cyan
    & npx --yes sass --style=expanded --source-map $ScssFile $CssFile --load-path=$ScssDir
  }
  exit $LASTEXITCODE
}

if ($Mode -eq 'prod') {
  Write-Host "[Sass] Compiling (prod) → $CssFile" -ForegroundColor Cyan
  & npx --yes sass --style=expanded $ScssFile $CssFile --no-source-map --load-path=$ScssDir
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "[PostCSS] Autoprefix → $AutoFile" -ForegroundColor Cyan
  & npx --yes postcss $CssFile --use autoprefixer --no-map -o $AutoFile
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "[PostCSS] Minify → $MinFile" -ForegroundColor Cyan
  & npx --yes postcss $AutoFile --use cssnano --no-map -o $MinFile
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Remove-Item $AutoFile -ErrorAction SilentlyContinue
  if ($ToMain.IsPresent) {
    Copy-Item $MinFile $CssFile -Force
    Write-Host "Done. Wrote minified CSS to main.css for production use." -ForegroundColor Green
  }
  else {
    Write-Host "Done. Use main.min.css in production." -ForegroundColor Green
  }
  exit 0
}

Write-Error "Unknown mode: $Mode (use 'dev' or 'prod')"


