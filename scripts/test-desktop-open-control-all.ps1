param(
  [ValidateSet("open-control", "start-session")]
  [string]$Action = "open-control",
  [int]$PerDeviceTimeoutSec = 75
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\\settings.json"
$tempRoot = Join-Path $root "tmp\\desktop-tests"

function Get-Settings {
  if (Test-Path -LiteralPath $settingsPath) {
    return Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  }

  return [pscustomobject]@{
    host = "127.0.0.1"
    port = 7780
  }
}

function Resolve-DesktopExe {
  $candidates = @(
    (Join-Path $root "dist\\win-arm64-unpacked\\RouterFarm.exe"),
    (Join-Path $root "dist\\win-x64-unpacked\\RouterFarm.exe"),
    "C:\\Program Files\\RouterFarm\\RouterFarm.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  throw "RouterFarm desktop executable was not found."
}

function Wait-ForTestOutput {
  param(
    [string]$Path,
    [int]$TimeoutSec
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if (Test-Path -LiteralPath $Path) {
      return Get-Content -Raw -Path $Path | ConvertFrom-Json
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for desktop test output: $Path"
}

function Stop-DesktopApp {
  try {
    Get-Process -Name "RouterFarm" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction Stop
  }
  catch {
    # Continue; there may be no running app or one process may already be exiting.
  }
}

$settings = Get-Settings
$baseUrl = "http://$($settings.host):$($settings.port)"
$desktopExe = Resolve-DesktopExe
$devices = Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 20 | Select-Object -ExpandProperty devices
$onlineDevices = @($devices | Where-Object { $_.online })
$results = @()

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
Stop-DesktopApp

foreach ($device in $onlineDevices) {
  $safeSerial = $device.serial -replace "[^A-Za-z0-9_-]", "_"
  $outputPath = Join-Path $tempRoot "$Action-$safeSerial.json"
  if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Force
  }

  $actionArg = if ($Action -eq "start-session") {
    "--phonefarm-test-start-session=$($device.serial)"
  } else {
    "--phonefarm-test-open-control=$($device.serial)"
  }

  Stop-DesktopApp
  Start-Process -FilePath $desktopExe -WorkingDirectory (Split-Path -Parent $desktopExe) -ArgumentList @(
    $actionArg,
    "--phonefarm-test-output=$outputPath",
    "--phonefarm-test-exit"
  ) | Out-Null

  $payload = $null
  $requestError = ""
  try {
    $payload = Wait-ForTestOutput -Path $outputPath -TimeoutSec $PerDeviceTimeoutSec
  }
  catch {
    $requestError = $_.Exception.Message
  }

  Start-Sleep -Seconds 2

  $statusDevice = Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 20 |
    Select-Object -ExpandProperty devices |
    Where-Object { $_.serial -eq $device.serial } |
    Select-Object -First 1

  $results += [pscustomobject]@{
    Serial = $device.serial
    Nickname = $device.nickname
    Action = $Action
    TestOk = [bool]($payload -and $payload.ok)
    BridgeReady = [bool]($payload -and $payload.bridgeReady)
    RequestError = $requestError
    NativePid = if ($payload) { $payload.nativeLaunch.pid } else { $null }
    NativeProcess = if ($payload) { $payload.nativeLaunch.processName } else { "" }
    WindowReady = if ($payload) { $payload.nativeLaunch.windowReady } else { $false }
    FallbackViewer = if ($payload) { $payload.nativeLaunch.fallbackViewer } else { "" }
    ViewerStatus = $statusDevice.viewerLaunch.status
    ViewerPid = $statusDevice.viewerLaunch.pid
    ViewerError = $statusDevice.viewerLaunch.lastError
  }

  try {
    & (Join-Path $PSScriptRoot "stop-scrcpy-for-device.ps1") -Serial $device.serial | Out-Null
  }
  catch {
    # Continue collecting results if cleanup fails.
  }

  if ($Action -eq "start-session") {
    try {
      Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "$baseUrl/api/devices/$($device.serial)/stop-session" -Body "{}" -TimeoutSec 30 | Out-Null
    }
    catch {
      # Continue; stop failures are useful signal but should not abort the suite.
    }
  }

  Stop-DesktopApp
  Start-Sleep -Milliseconds 600
}

$results | Format-Table -AutoSize
