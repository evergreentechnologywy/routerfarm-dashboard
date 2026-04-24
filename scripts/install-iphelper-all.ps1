#requires -Version 5.1
<#
.SYNOPSIS
    Mass-installs the RouterFarm IP Helper APK to all authorized ADB devices.
.DESCRIPTION
    Finds all ADB devices in "device" state (authorized), installs the APK
    to each one sequentially, and reports results.
    Skips unauthorized devices with a warning.
.NOTES
    Run from the project root or set -ApkPath explicitly.
#>
[CmdletBinding()]
param(
    [string]$ApkPath = "",
    [switch]$SkipUnauthorizedPrompt
)

$ErrorActionPreference = "Stop"

# Resolve APK path
if ([string]::IsNullOrWhiteSpace($ApkPath)) {
    $candidates = @(
        "config/routerfarm-ip-helper.apk",
        "android/routerfarm-ip-helper/app/build/outputs/apk/debug/app-debug.apk",
        "android/routerfarm-ip-helper/app/build/outputs/apk/release/app-release.apk",
        "android/routerfarm-ip-helper/build/outputs/apk/debug/app-debug.apk",
        "android/routerfarm-ip-helper/build/outputs/apk/release/app-release.apk"
    )
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
    $projectRoot = Resolve-Path (Join-Path $scriptDir "..")
    foreach ($c in $candidates) {
        $full = Join-Path $projectRoot $c
        if (Test-Path $full) {
            $ApkPath = $full
            break
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ApkPath) -or -not (Test-Path $ApkPath)) {
    Write-Host "ERROR: APK not found." -ForegroundColor Red
    Write-Host "Build it first in Android Studio, then run again." -ForegroundColor Yellow
    Write-Host "Expected locations:" -ForegroundColor Yellow
    Write-Host "  android/routerfarm-ip-helper/app/build/outputs/apk/debug/app-debug.apk" -ForegroundColor DarkGray
    Write-Host "  android/routerfarm-ip-helper/app/build/outputs/apk/release/app-release.apk" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Or specify the path explicitly:" -ForegroundColor Yellow
    Write-Host "  .\scripts\install-iphelper-all.ps1 -ApkPath C:\Path\To\app-debug.apk" -ForegroundColor DarkGray
    exit 1
}

$ApkPath = Resolve-Path $ApkPath
Write-Host "APK: $ApkPath" -ForegroundColor Cyan

# Check adb
$adb = & adb version 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: adb not found in PATH. Install Android Platform Tools." -ForegroundColor Red
    exit 1
}

# Enumerate devices
$lines = & adb devices -l 2>$null
$devices = @()
$unauthorized = @()

foreach ($line in $lines) {
    if ($line -match "^([A-Za-z0-9]+)\s+device\s+") {
        $serial = $Matches[1]
        $devices += $serial
    }
    elseif ($line -match "^([A-Za-z0-9]+)\s+unauthorized\s+") {
        $serial = $Matches[1]
        $unauthorized += $serial
    }
}

Write-Host ""
Write-Host "Authorized devices  : $($devices.Count)" -ForegroundColor Green
Write-Host "Unauthorized devices: $($unauthorized.Count)" -ForegroundColor Yellow

if ($unauthorized.Count -gt 0 -and -not $SkipUnauthorizedPrompt) {
    Write-Host ""
    Write-Host "Unauthorized serials:" -ForegroundColor Yellow
    foreach ($s in $unauthorized) {
        Write-Host "  - $s" -ForegroundColor DarkYellow
    }
    Write-Host ""
    Write-Host "These devices need the 'Allow USB debugging?' dialog tapped on their screens." -ForegroundColor Yellow
    $continue = Read-Host "Continue installing to authorized devices only? [Y/n]"
    if ($continue -and $continue.Trim().ToLower() -eq "n") {
        Write-Host "Aborted." -ForegroundColor Red
        exit 1
    }
}

if ($devices.Count -eq 0) {
    Write-Host "ERROR: No authorized devices found. Connect phones and authorize USB debugging." -ForegroundColor Red
    exit 1
}

# Install to each device
$success = @()
$failed = @()
$sw = [System.Diagnostics.Stopwatch]::StartNew()

for ($i = 0; $i -lt $devices.Count; $i++) {
    $serial = $devices[$i]
    $n = $i + 1
    Write-Host ""
    Write-Host "[$n/$($devices.Count)] Installing to $serial ..." -NoNewline -ForegroundColor Cyan

    $output = & adb -s $serial install -r -d "$ApkPath" 2>&1
    $exit = $LASTEXITCODE

    if ($exit -eq 0 -and ($output -join " ") -match "Success") {
        Write-Host " OK" -ForegroundColor Green
        $success += $serial
    }
    else {
        Write-Host " FAILED" -ForegroundColor Red
        Write-Host "  $output" -ForegroundColor DarkGray
        $failed += $serial
    }
}

$sw.Stop()

# Summary
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Install complete in $($sw.Elapsed.ToString('mm\:ss'))" -ForegroundColor Cyan
Write-Host "Success : $($success.Count)" -ForegroundColor Green
if ($failed.Count -gt 0) {
    Write-Host "Failed  : $($failed.Count)" -ForegroundColor Red
    foreach ($s in $failed) {
        Write-Host "  - $s" -ForegroundColor DarkRed
    }
}
if ($unauthorized.Count -gt 0) {
    Write-Host "Skipped (unauthorized): $($unauthorized.Count)" -ForegroundColor Yellow
}
Write-Host "============================================" -ForegroundColor Cyan

if ($failed.Count -gt 0) { exit 1 } else { exit 0 }
