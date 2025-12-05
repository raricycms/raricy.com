$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$outDir = Join-Path $PSScriptRoot '..' | Join-Path -ChildPath 'app' | Join-Path -ChildPath 'static' | Join-Path -ChildPath 'js'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$outFile = Join-Path $outDir 'dompurify.min.js'
$url = 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js'

Write-Host "Downloading DOMPurify to $outFile ..."
Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing

if (-not (Test-Path $outFile)) { throw "Failed to download DOMPurify" }
$size = (Get-Item $outFile).Length
Write-Host "Done. Size: $size bytes"

