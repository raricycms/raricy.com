$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host "Fetching frontend dependencies (marked, DOMPurify, highlight.js, Vditor) ..."

& "$PSScriptRoot/fetch_marked.ps1"
& "$PSScriptRoot/fetch_dompurify.ps1"
& "$PSScriptRoot/fetch_highlight.ps1"
& "$PSScriptRoot/fetch_vditor.ps1"

Write-Host "All frontend dependencies fetched."

