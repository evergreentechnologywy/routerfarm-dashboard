#requires -Version 5.1
<#
.SYNOPSIS
    Launches scrcpy for all connected ADB devices to enable screen-based USB debugging authorization.
.DESCRIPTION
    Tries to open an scrcpy window for every connected device.
    - Authorized devices launch immediately.
    - Unauthorized devices are retried in a background watch loop.
    Press Ctrl+C to stop the watch loop.
.NOTES
    Run from the project root. Requires scrcpy in PATH or configured in settings.json.
#>
[CmdletBinding()]
param(
    [switch]$NoWatch,
    [int]$WatchIntervalSec = 3
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\settings.json"
$activityLogPath = Join-Path $root "logs\activity.log"

function Write-ActivityLog {
    param([string]$Category, [string]$Message, [string]$DeviceSerial = "")
    $timestamp = (Get-Date).ToString("o")
    $serialSegment = if ($DeviceSerial) { " [$DeviceSerial]" } else { "" }
    $line = "[$timestamp] [$Category]$serialSegment $Message"
    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
        try {
            Add-Content -Path $activityLogPath -Value $line -ErrorAction Stop
            return
        }
        catch {
            if ($attempt -eq 3) { return }
            Start-Sleep -Milliseconds (100 * $attempt)
        }
    }
}

function Get-Settings {
    if (Test-Path $settingsPath) {
        return Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
    }
    return [pscustomobject]@{ adbPath = "adb"; scrcpyPath = "scrcpy" }
}

function Resolve-ToolPath {
    param([string]$ConfiguredPath, [string]$FallbackName)
    if ($ConfiguredPath -and (Test-Path -LiteralPath $ConfiguredPath)) { return $ConfiguredPath }
    $command = Get-Command $FallbackName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    if ($ConfiguredPath) { return $ConfiguredPath }
    return $FallbackName
}

function Get-AdbDevices {
    param([string]$AdbPath)
    $lines = & $AdbPath devices -l 2>$null
    $authorized = @()
    $unauthorized = @()
    foreach ($line in $lines) {
        if ($line -match "^([A-Za-z0-9]+)\s+device\s+") {
            $authorized += $Matches[1]
        }
        elseif ($line -match "^([A-Za-z0-9]+)\s+unauthorized\s+") {
            $unauthorized += $Matches[1]
        }
    }
    return [pscustomobject]@{ Authorized = $authorized; Unauthorized = $unauthorized }
}

function Launch-Scrcpy {
    param([string]$ScrcpyPath, [string]$Serial)
    $workingDirectory = Split-Path -Parent $ScrcpyPath
    $windowTitle = "RouterFarm-$Serial"
    $launchArgs = @("--serial=$Serial", "--no-audio", "--window-title=$windowTitle")

    # Check if already running
    $existing = @(Get-Process -Name "scrcpy" -ErrorAction SilentlyContinue | Where-Object {
        try { $_.MainWindowTitle -eq $windowTitle } catch { $false }
    })
    if ($existing.Count -gt 0) {
        return [pscustomobject]@{ Ok = $true; Serial = $Serial; Skipped = $true; Reason = "Already running (PID $($existing[0].Id))" }
    }

    try {
        $proc = Start-Process -FilePath $ScrcpyPath -WorkingDirectory $workingDirectory -ArgumentList $launchArgs -PassThru -WindowStyle Normal
        Start-Sleep -Milliseconds 800
        return [pscustomobject]@{ Ok = $true; Serial = $Serial; Skipped = $false; Pid = $proc.Id }
    }
    catch {
        return [pscustomobject]@{ Ok = $false; Serial = $Serial; Error = $_.Exception.Message }
    }
}

# Main
$settings = Get-Settings
$adbPath = Resolve-ToolPath -ConfiguredPath $settings.adbPath -FallbackName "adb"
$scrcpyPath = Resolve-ToolPath -ConfiguredPath $settings.scrcpyPath -FallbackName "scrcpy"

if (-not (Test-Path -LiteralPath $scrcpyPath)) {
    Write-Host "ERROR: scrcpy not found at $scrcpyPath" -ForegroundColor Red
    Write-Host "Install scrcpy or add it to settings.json (scrcpyPath)" -ForegroundColor Yellow
    exit 1
}

Write-Host "scrcpy: $scrcpyPath" -ForegroundColor Cyan
Write-Host ""

$launched = @()
$failed = @()
$skipped = @()
$pending = @()

$devices = Get-AdbDevices -AdbPath $adbPath

# Launch for authorized devices
foreach ($serial in $devices.Authorized) {
    $result = Launch-Scrcpy -ScrcpyPath $scrcpyPath -Serial $serial
    if ($result.Ok) {
        if ($result.Skipped) {
            Write-Host "[$serial] Already running $($result.Reason)" -ForegroundColor DarkGray
            $skipped += $serial
        }
        else {
            Write-Host "[$serial] Launched (PID $($result.Pid))" -ForegroundColor Green
            $launched += $serial
            Write-ActivityLog -Category "scrcpy-batch" -Message "Launched scrcpy (PID $($result.Pid))" -DeviceSerial $serial
        }
    }
    else {
        Write-Host "[$serial] Launch failed: $($result.Error)" -ForegroundColor Red
        $failed += $serial
    }
}

# For unauthorized, attempt once (sometimes works) then queue for watch
foreach ($serial in $devices.Unauthorized) {
    Write-Host "[$serial] Unauthorized — attempting scrcpy anyway..." -NoNewline -ForegroundColor Yellow
    $result = Launch-Scrcpy -ScrcpyPath $scrcpyPath -Serial $serial
    if ($result.Ok -and -not $result.Skipped) {
        Write-Host " OK (unexpected success!)" -ForegroundColor Green
        $launched += $serial
    }
    else {
        Write-Host " failed, queued for retry" -ForegroundColor DarkYellow
        $pending += $serial
    }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Initial launch complete" -ForegroundColor Cyan
Write-Host "Launched   : $($launched.Count)" -ForegroundColor Green
Write-Host "Skipped    : $($skipped.Count)" -ForegroundColor DarkGray
Write-Host "Failed     : $($failed.Count)" -ForegroundColor Red
Write-Host "Unauthorized (pending): $($pending.Count)" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan

if ($NoWatch -or $pending.Count -eq 0) {
    if ($pending.Count -gt 0) {
        Write-Host ""
        Write-Host "To authorize: unplug and replug each phone, tap 'Allow USB debugging?' on the screen," -ForegroundColor Yellow
        Write-Host "then re-run this script." -ForegroundColor Yellow
    }
    exit 0
}

# Watch loop
Write-Host ""
Write-Host "Watching for newly authorized devices every ${WatchIntervalSec}s..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

$knownAuthorized = New-Object System.Collections.Generic.HashSet[string]
foreach ($s in $devices.Authorized) { [void]$knownAuthorized.Add($s) }
foreach ($s in $launched) { [void]$knownAuthorized.Add($s) }

$watchStart = Get-Date
$watchedLaunched = @()

try {
    while ($true) {
        Start-Sleep -Seconds $WatchIntervalSec
        $current = Get-AdbDevices -AdbPath $adbPath

        foreach ($serial in $current.Authorized) {
            if (-not $knownAuthorized.Contains($serial)) {
                [void]$knownAuthorized.Add($serial)
                Write-Host "[$serial] Newly authorized! Launching scrcpy..." -NoNewline -ForegroundColor Cyan
                $result = Launch-Scrcpy -ScrcpyPath $scrcpyPath -Serial $serial
                if ($result.Ok -and -not $result.Skipped) {
                    Write-Host " OK" -ForegroundColor Green
                    $watchedLaunched += $serial
                    Write-ActivityLog -Category "scrcpy-batch" -Message "Auto-launched after authorization" -DeviceSerial $serial
                }
                else {
                    Write-Host " failed" -ForegroundColor Red
                }
            }
        }
    }
}
catch {
    # Ctrl+C or other break
}

Write-Host ""
Write-Host "Watch stopped. Auto-launched during watch: $($watchedLaunched.Count)" -ForegroundColor Cyan
foreach ($s in $watchedLaunched) {
    Write-Host "  - $s" -ForegroundColor Green
}

$stillUnauthorized = @(Get-AdbDevices -AdbPath $adbPath).Unauthorized
if ($stillUnauthorized.Count -gt 0) {
    Write-Host "Still unauthorized: $($stillUnauthorized.Count)" -ForegroundColor Yellow
    foreach ($s in $stillUnauthorized) {
        Write-Host "  - $s" -ForegroundColor DarkYellow
    }
}
