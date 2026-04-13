param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\\settings.json"
$activityLogPath = Join-Path $root "logs\\activity.log"

function Get-Settings {
  if (Test-Path $settingsPath) {
    return Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{
    host = "127.0.0.1"
    port = 7780
    scrcpyPath = "scrcpy"
  }
}

function Get-NewProcessDelta {
  param(
    [object[]]$Before,
    [object[]]$After
  )

  return Compare-Object -ReferenceObject $Before -DifferenceObject $After -Property Id,ProcessName,StartTime |
    Where-Object { $_.SideIndicator -eq "=>" }
}

function Stop-NewViewerProcesses {
  param([object[]]$Processes)

  foreach ($process in $Processes) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
    }
    catch {
      # Ignore cleanup failures; some launches may terminate on their own.
    }
  }
}

$settings = Get-Settings
$baseUrl = "http://$($settings.host):$($settings.port)"
$devices = Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 20 | Select-Object -ExpandProperty devices
$onlineDevices = @($devices | Where-Object { $_.online })
$results = @()

foreach ($device in $onlineDevices) {
  $before = Get-Process -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime
  $response = $null
  $requestError = ""
  try {
    $response = Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "$baseUrl/api/devices/$($device.serial)/start-session" -Body "{}" -TimeoutSec 90
  }
  catch {
    $requestError = $_.Exception.Message
  }

  Start-Sleep -Seconds 3
  $after = Get-Process -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime
  $delta = @(Get-NewProcessDelta -Before $before -After $after)
  $statusDevice = Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 20 | Select-Object -ExpandProperty devices | Where-Object { $_.serial -eq $device.serial } | Select-Object -First 1

  $results += [pscustomobject]@{
    Serial = $device.serial
    Nickname = $device.nickname
    PrepState = $device.prepState
    RequestOk = [bool]$response.ok
    RequestError = $requestError
    SessionState = $statusDevice.sessionState
    ViewerStatus = $statusDevice.viewerLaunch.status
    ViewerPid = $statusDevice.viewerLaunch.pid
    ViewerAliveAfterLaunch = $statusDevice.viewerLaunch.aliveAfterLaunch
    NewProcesses = ($delta | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ", "
  }

  Stop-NewViewerProcesses -Processes $delta
  try {
    Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "$baseUrl/api/devices/$($device.serial)/stop-session" -Body "{}" -TimeoutSec 30 | Out-Null
  }
  catch {
    # Keep going; stop failures are part of the signal.
  }
  Start-Sleep -Milliseconds 500
}

$results | Format-Table -AutoSize
