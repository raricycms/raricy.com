$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$jsDir = Join-Path $PSScriptRoot '..' | Join-Path -ChildPath 'app' | Join-Path -ChildPath 'static' | Join-Path -ChildPath 'js'
$cssDir = Join-Path $PSScriptRoot '..' | Join-Path -ChildPath 'app' | Join-Path -ChildPath 'static' | Join-Path -ChildPath 'css' | Join-Path -ChildPath 'hljs'
New-Item -ItemType Directory -Force -Path $jsDir | Out-Null
New-Item -ItemType Directory -Force -Path $cssDir | Out-Null

$jsOut = Join-Path $jsDir 'highlight.min.js'
$cssLight = Join-Path $cssDir 'default.min.css'
$cssDark = Join-Path $cssDir 'monokai.min.css'

$urlJs = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js'
$urlLight = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/default.min.css'
$urlDark = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/monokai.min.css'

Write-Host "Downloading highlight.js and CSS..."
Invoke-WebRequest -Uri $urlJs -OutFile $jsOut -UseBasicParsing
Invoke-WebRequest -Uri $urlLight -OutFile $cssLight -UseBasicParsing
Invoke-WebRequest -Uri $urlDark -OutFile $cssDark -UseBasicParsing

if (-not (Test-Path $jsOut)) { throw "Failed to download highlight.js" }
if (-not (Test-Path $cssLight)) { throw "Failed to download default.min.css" }
if (-not (Test-Path $cssDark)) { throw "Failed to download monokai.min.css" }

Write-Host "Done."

