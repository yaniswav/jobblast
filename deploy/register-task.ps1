#Requires -Version 7.0
<#
.SYNOPSIS
    Registers (or re-registers) the "JobBlast" Windows Scheduled Task so the
    app starts automatically at logon and survives reboots.
.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\register-task.ps1
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $repoRoot "deploy\start-jobblast.ps1"
$taskName = "JobBlast"

$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $pwshCmd) {
    Write-Error "pwsh (PowerShell 7) not found on PATH."
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute $pwshCmd.Source `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`"" `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -Hidden `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Write-Host "==> Task '$taskName' already exists, replacing it..." -ForegroundColor Cyan
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Starts the JobBlast API (and its Postgres/Docker dependency) at user logon so it survives reboots." `
    | Out-Null

Write-Host "==> Scheduled task '$taskName' registered." -ForegroundColor Green
Get-ScheduledTask -TaskName $taskName | Format-List TaskName, State
