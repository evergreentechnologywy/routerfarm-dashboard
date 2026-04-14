param(
  [string]$ExePath = "C:\Users\everg\routerfarm-release\dist\win-unpacked\RouterFarm.exe",
  [string]$StatusUrl = "http://127.0.0.1:7781/api/status",
  [int]$PollSeconds = 20,
  [int]$StartWaitSeconds = 12,
  [string]$LogPath = "C:\Users\everg\routerfarm-release\logs\watch-routerfarm.log",
  [string]$MaintenanceLockPath = "C:\Users\everg\routerfarm-release\logs\watch-routerfarm.maintenance.lock"
)

$ErrorActionPreference = "Stop"

function Write-WatchLog {
  param([string]$Message)
  $dir = Split-Path -Parent $LogPath
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f ([DateTime]::Now.ToString("s")), $Message)
}

function Test-RouterFarmHealthy {
  try {
    $response = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 8
    return [bool]$response.ok
  } catch {
    return $false
  }
}

function Stop-RouterFarmProcesses {
  Get-Process RouterFarm -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Test-MaintenanceMode {
  return Test-Path -LiteralPath $MaintenanceLockPath
}

function Start-RouterFarm {
  if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "RouterFarm executable not found at $ExePath"
  }
  Start-Process -FilePath $ExePath | Out-Null
  Start-Sleep -Seconds $StartWaitSeconds
}

Write-WatchLog "Watchdog started. Monitoring $StatusUrl"

while ($true) {
  try {
    if (Test-MaintenanceMode) {
      Write-WatchLog "Maintenance lock detected. Skipping recovery checks."
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    $running = @(Get-Process RouterFarm -ErrorAction SilentlyContinue).Count -gt 0
    $healthy = Test-RouterFarmHealthy

    if (-not $running -or -not $healthy) {
      Write-WatchLog ("Recovery triggered. Running={0} Healthy={1}" -f $running, $healthy)
      Stop-RouterFarmProcesses
      Start-RouterFarm
      $recovered = Test-RouterFarmHealthy
      Write-WatchLog ("Recovery result. Healthy={0}" -f $recovered)
    }
  } catch {
    Write-WatchLog ("Watchdog error: " + $_.Exception.Message)
  }

  Start-Sleep -Seconds $PollSeconds
}
