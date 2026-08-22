#Requires -Version 7.0
<#
.SYNOPSIS
    Production build for JobBlast: typecheck, build the frontend (jobblast),
    then build the API server bundle. Fails loudly (non-zero exit) on the
    first error.
.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\build.ps1
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "==> [1/3] pnpm run typecheck" -ForegroundColor Cyan
pnpm run typecheck
if ($LASTEXITCODE -ne 0) {
    Write-Error "Typecheck FAILED (exit code $LASTEXITCODE)"
    exit 1
}

Write-Host "==> [2/3] Building frontend (@workspace/jobblast, BASE_PATH=/)" -ForegroundColor Cyan
$env:BASE_PATH = "/"
try {
    pnpm --filter @workspace/jobblast run build
    $frontendExit = $LASTEXITCODE
}
finally {
    Remove-Item Env:\BASE_PATH -ErrorAction SilentlyContinue
}
if ($frontendExit -ne 0) {
    Write-Error "Frontend build FAILED (exit code $frontendExit)"
    exit 1
}

Write-Host "==> [3/3] Building API server (@workspace/api-server)" -ForegroundColor Cyan
pnpm --filter @workspace/api-server run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "API server build FAILED (exit code $LASTEXITCODE)"
    exit 1
}

Write-Host "==> Build succeeded." -ForegroundColor Green
