$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Target directory for local npm install
$staticDir = Join-Path $PSScriptRoot '..' | Join-Path -ChildPath 'app' | Join-Path -ChildPath 'static'
$pkgDir = Join-Path $staticDir 'js' | Join-Path -ChildPath 'vditor'
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null

$runner = if ($env:NPM_RUNNER) { $env:NPM_RUNNER } else { 'npm' }
if (-not (Get-Command $runner -ErrorAction SilentlyContinue)) {
  throw "Package manager '$runner' not found. Set NPM_RUNNER to npm/pnpm/yarn."
}

Push-Location $pkgDir
try {
  if (-not (Test-Path (Join-Path $pkgDir 'package.json'))) {
    & $runner init -y | Out-Null
  }
  $ver = if ($env:VDITOR_VERSION) { $env:VDITOR_VERSION } else { 'latest' }
  & $runner install "vditor@$ver" --save --silent | Out-Null
} finally {
  Pop-Location
}

$distDir = Join-Path $pkgDir 'node_modules' | Join-Path -ChildPath 'vditor' | Join-Path -ChildPath 'dist'
if (-not (Test-Path $distDir)) {
  throw "Vditor dist not found at $distDir"
}
Write-Host "Vditor installed at $distDir"


