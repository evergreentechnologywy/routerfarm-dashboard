param(
  [string]$SettingsPath = "C:\RouterFarm\config\settings.json",
  [string]$ApkPath = "C:\RouterFarm\config\routerfarm-ip-helper.apk",
  [string[]]$Serial = @()
)

$ErrorActionPreference = "Stop"

function Get-Settings {
  if (Test-Path $SettingsPath) {
    return Get-Content -Raw -Path $SettingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{ adbPath = "adb" }
}

function Resolve-AdbPath {
  param([string]$ConfiguredPath)

  if ($ConfiguredPath -and (Test-Path $ConfiguredPath)) {
    return $ConfiguredPath
  }

  $adbCommand = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($adbCommand -and $adbCommand.Source) {
    return $adbCommand.Source
  }

  return "adb"
}

if (-not (Test-Path $ApkPath)) {
  throw "Helper APK not found at $ApkPath. Build it first with build-routerfarm-ip-helper.ps1."
}

$settings = Get-Settings
$adb = Resolve-AdbPath -ConfiguredPath $settings.adbPath

if (-not $Serial -or $Serial.Count -eq 0) {
  $devicesOutput = & $adb devices
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to query adb devices."
  }
  $Serial = @(
    $devicesOutput |
      Select-String "^\S+\s+device$" |
      ForEach-Object { ($_ -split "\s+")[0] }
  )
}

foreach ($deviceSerial in $Serial) {
  Write-Host "Installing helper on $deviceSerial"
  & $adb -s $deviceSerial install -r $ApkPath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install helper on $deviceSerial"
  }
}
