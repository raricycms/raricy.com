$ErrorActionPreference = 'Stop'

$ProgressPreference = 'SilentlyContinue'

$outDir = Join-Path $PSScriptRoot '..' | Join-Path -ChildPath 'app' | Join-Path -ChildPath 'static' | Join-Path -ChildPath 'js'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$outFile = Join-Path $outDir 'marked.min.js'
$url = 'https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js'

Write-Host "Downloading marked.min.js to $outFile ..."
Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing

if (-not (Test-Path $outFile)) {
  throw "Failed to download marked.min.js"
}

$size = (Get-Item $outFile).Length
Write-Host "Done. Size: $size bytes"

