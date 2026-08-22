#Requires -Version 7.0
<#
.SYNOPSIS
    Idempotent startup for the JobBlast "production" deployment:
      (a) makes sure Docker Desktop is running,
      (b) makes sure the jobblast-pg Postgres container is up and ready,
      (c) does nothing if the API is already listening on its port,
      (d) otherwise starts the built API server (SERVE_STATIC=1) hidden,
          appending its output to deploy\logs\jobblast.log.
.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\start-jobblast.ps1
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$apiDir = Join-Path $repoRoot "artifacts\api-server"
$distEntry = Join-Path $apiDir "dist\index.mjs"
$logDir = Join-Path $repoRoot "deploy\logs"
$logFile = Join-Path $logDir "jobblast.log"
$containerName = "jobblast-pg"

# Read PORT from the root .env (fallback 5000) so this stays in sync even if
# it's changed later.
$envFile = Join-Path $repoRoot ".env"
$port = 5000
if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
    if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
}

if (-not (Test-Path $distEntry)) {
    Write-Error "Build output not found at $distEntry. Run deploy\build.ps1 first."
    exit 1
}

# --- (a) Docker Desktop must be running -------------------------------------------------

function Test-DockerRunning {
    docker ps *> $null
    return ($LASTEXITCODE -eq 0)
}

if (-not (Test-DockerRunning)) {
    Write-Host "==> Docker daemon not responding, starting Docker Desktop..." -ForegroundColor Yellow
    $dockerDesktopExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerDesktopExe) {
        Start-Process -FilePath $dockerDesktopExe | Out-Null
    }
    else {
        Write-Error "Docker Desktop executable not found at $dockerDesktopExe"
        exit 1
    }

    $elapsed = 0
    $timeout = 120
    while (-not (Test-DockerRunning) -and $elapsed -lt $timeout) {
        Start-Sleep -Seconds 3
        $elapsed += 3
    }
    if (-not (Test-DockerRunning)) {
        Write-Error "Docker daemon did not become ready within $timeout seconds."
        exit 1
    }
    Write-Host "==> Docker daemon is ready." -ForegroundColor Green
}
else {
    Write-Host "==> Docker daemon already running." -ForegroundColor Green
}

# --- (b) jobblast-pg container must be up and ready --------------------------------------

$pgRunning = docker ps --filter "name=^/${containerName}$" --filter "status=running" --format "{{.Names}}" 2>$null
if (-not $pgRunning) {
    Write-Host "==> Starting container '$containerName'..." -ForegroundColor Cyan
    docker start $containerName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to start container '$containerName'. Does it exist? (docker ps -a)"
        exit 1
    }
}
else {
    Write-Host "==> Container '$containerName' already running." -ForegroundColor Green
}

Write-Host "==> Waiting for Postgres to be ready..." -ForegroundColor Cyan
$elapsed = 0
$timeout = 60
$ready = $false
do {
    docker exec $containerName pg_isready -U postgres *> $null
    $ready = ($LASTEXITCODE -eq 0)
    if (-not $ready) {
        Start-Sleep -Seconds 2
        $elapsed += 2
    }
} while (-not $ready -and $elapsed -lt $timeout)

if (-not $ready) {
    Write-Error "Postgres did not become ready within $timeout seconds."
    exit 1
}
Write-Host "==> Postgres is ready." -ForegroundColor Green

# --- (c) Already running? ------------------------------------------------------------------

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $existingPids = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
    Write-Host "==> JobBlast API already listening on port $port (PID $existingPids). Nothing to do." -ForegroundColor Green
    exit 0
}

# --- (d) Start the API server, hidden, logging to deploy\logs\jobblast.log ----------------

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 5MB)) {
    $oldLogFile = Join-Path $logDir "jobblast.log.old"
    Write-Host "==> Rotating log ($([math]::Round((Get-Item $logFile).Length / 1MB, 1)) MB) -> jobblast.log.old" -ForegroundColor Yellow
    Move-Item -Path $logFile -Destination $oldLogFile -Force
}

$env:SERVE_STATIC = "1"

Write-Host "==> Starting JobBlast API (SERVE_STATIC=1) from $apiDir ..." -ForegroundColor Cyan

# Start-Process's own -RedirectStandardOutput/-RedirectStandardError params
# always create/overwrite two SEPARATE files, they cannot append both
# streams to one shared log. To get a single appended combined log file, we
# use Start-Process to launch a hidden pwsh wrapper whose only job is to run
# the real "node ./dist/index.mjs" command with `*>>` (append, all streams).
$nodeCommandLine =
    "node --enable-source-maps --env-file-if-exists=../../.env ./dist/index.mjs *>> `"$logFile`""

Start-Process -FilePath "pwsh" `
    -ArgumentList @("-NoProfile", "-Command", $nodeCommandLine) `
    -WorkingDirectory $apiDir `
    -WindowStyle Hidden `
    | Out-Null

$elapsed = 0
$timeout = 30
$started = $false
$listening = $null
while ($elapsed -lt $timeout) {
    Start-Sleep -Seconds 1
    $elapsed += 1
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
        $started = $true
        break
    }
}

if ($started) {
    $newPids = ($listening | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
    Write-Host "==> JobBlast API started (PID $newPids) -> http://localhost:$port/" -ForegroundColor Green
}
else {
    Write-Error "JobBlast API did not start listening on port $port within $timeout seconds. Check $logFile"
    exit 1
}
