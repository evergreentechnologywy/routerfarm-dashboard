param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\\settings.json"

function Get-Settings {
  if (Test-Path $settingsPath) {
    return Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  }

  return [pscustomobject]@{
    host = "127.0.0.1"
    port = 7780
  }
}

$settings = Get-Settings
$baseUrl = "http://$($settings.host):$($settings.port)"
$devices = Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 20 | Select-Object -ExpandProperty devices
$onlineDevices = @($devices | Where-Object { $_.online })
$results = @()

foreach ($device in $onlineDevices) {
  $response = $null
  $requestError = ""

  try {
    $response = Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "$baseUrl/api/devices/$($device.serial)/open-control" -Body "{}" -TimeoutSec 45
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
    RequestOk = [bool]$response.ok
    RequestError = $requestError
    ViewerStatus = $statusDevice.viewerLaunch.status
    ViewerPid = $statusDevice.viewerLaunch.pid
    WindowReady = $statusDevice.viewerLaunch.windowReady
    ViewerError = $statusDevice.viewerLaunch.lastError
  }

  try {
    & (Join-Path $PSScriptRoot "stop-scrcpy-for-device.ps1") -Serial $device.serial
  }
  catch {
    # Continue collecting results if cleanup fails.
  }

  Start-Sleep -Milliseconds 500
}

$results | Format-Table -AutoSize
