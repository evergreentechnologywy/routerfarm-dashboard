param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\\settings.json"
$activityLogPath = Join-Path $root "logs\\activity.log"

function Get-Settings {
  if (Test-Path $settingsPath) {
    return Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{ adbPath = "adb" }
}

function Write-ActivityLog {
  param([string]$Message)
  $timestamp = (Get-Date).ToString("o")
  Add-Content -Path $activityLogPath -Value "[$timestamp] [adb] $Message"
}

$settings = Get-Settings
$adbPath = if ($settings.adbPath) { $settings.adbPath } else { "adb" }

& $adbPath kill-server | Out-Null
& $adbPath start-server | Out-Null
Write-ActivityLog -Message "ADB server restarted"
Write-Output "ADB restarted using $adbPath"
