#requires -Version 5.1
<#
.SYNOPSIS
    Watches ADB devices and installs the IP Helper APK as soon as each becomes authorized.
.DESCRIPTION
    Monitors adb devices in a loop. When a device transitions from unauthorized to authorized,
    immediately runs adb install for it. Shows progress per device.
    Press Ctrl+C to stop.
#>
[CmdletBinding()]
param(
    [string]$ApkPath = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

# Resolve APK
if ([string]::IsNullOrWhiteSpace($ApkPath)) {
    $candidates = @(
        "config/routerfarm-ip-helper.apk",
        "android/routerfarm-ip-helper/app/build/outputs/apk/debug/app-debug.apk",
        "android/routerfarm-ip-helper/app/build/outputs/apk/release/app-release.apk"
    )
    foreach ($c in $candidates) {
        $full = Join-Path $root $c
        if (Test-Path $full) {
            $ApkPath = $full
            break
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ApkPath) -or -not (Test-Path $ApkPath)) {
    Write-Host "ERROR: APK not found." -ForegroundColor Red
    exit 1
}
$ApkPath = Resolve-Path $ApkPath
Write-Host "APK: $ApkPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Waiting for devices to become authorized..." -ForegroundColor Cyan
Write-Host "Tap 'Allow USB debugging' on each phone via scrcpy, and the APK will install automatically." -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

$installed = New-Object System.Collections.Generic.HashSet[string]
$attempted = New-Object System.Collections.Generic.HashSet[string]

while ($true) {
    $lines = & adb devices -l 2>$null
    foreach ($line in $lines) {
        if ($line -match "^([A-Za-z0-9]+)\s+device\s+") {
            $serial = $Matches[1]
            if (-not $installed.Contains($serial) -and -not $attempted.Contains($serial)) {
                [void]$attempted.Add($serial)
                Write-Host "[$serial] Authorized detected! Installing..." -NoNewline -ForegroundColor Cyan
                $output = & adb -s $serial install -r -d "$ApkPath" 2>&1
                $exit = $LASTEXITCODE
                if ($exit -eq 0 -and ($output -join " ") -match "Success") {
                    Write-Host " OK" -ForegroundColor Green
                    [void]$installed.Add($serial)
                }
                else {
                    Write-Host " FAILED" -ForegroundColor Red
                    Write-Host "  $output" -ForegroundColor DarkGray
                }
            }
        }
    }
    Start-Sleep -Seconds 2
}
