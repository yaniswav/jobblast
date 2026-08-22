#Requires -Version 7.0
<#
.SYNOPSIS
    Stops the JobBlast API by finding whichever process is listening on its
    port (read from the root .env, default 5000) and killing it.
.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\stop-jobblast.ps1
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$port = 5000
if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
    if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
}

$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
    Write-Host "==> Nothing listening on port $port. JobBlast API is not running." -ForegroundColor Yellow
    exit 0
}

$targetPids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($targetPid in $targetPids) {
    try {
        $proc = Get-Process -Id $targetPid -ErrorAction Stop
        Write-Host "==> Stopping $($proc.ProcessName) (PID $targetPid)..." -ForegroundColor Cyan
        Stop-Process -Id $targetPid -Force
        Write-Host "==> Stopped." -ForegroundColor Green
    }
    catch {
        Write-Warning "Could not stop PID $targetPid`: $_"
    }
}
