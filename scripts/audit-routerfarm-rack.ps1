param(
  [string]$RoutersPath,
  [string]$SettingsPath,
  [switch]$AsJson
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$projectRoot = Split-Path -Parent $scriptRoot
if (-not $RoutersPath) {
  $RoutersPath = Join-Path $projectRoot "config\routers.json"
}
if (-not $SettingsPath) {
  $SettingsPath = Join-Path $projectRoot "config\settings.json"
}

$routers = (Get-Content -LiteralPath $RoutersPath -Raw | ConvertFrom-Json).routers | Where-Object { $_.enabled }
$results = @()

foreach ($router in $routers) {
  $raw = $null
  try {
    $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot "invoke-routerfarm-router-action.ps1") `
      -RouterId $router.id `
      -Action "router-health" `
      -RoutersPath $RoutersPath `
      -SettingsPath $SettingsPath 2>$null

    $payload = $raw | ConvertFrom-Json
    $telemetry = $payload.telemetry
    $results += [pscustomobject]@{
      routerId = $router.id
      host = $router.host
      ok = [bool]$payload.ok
      mode = [string]$telemetry.mode
      uplinkMode = [string]$telemetry.uplinkMode
      tetheringState = [string]$telemetry.tetheringState
      publicIp = [string]$telemetry.publicIp
      usbPorts = [string]$telemetry.usbPorts
      tetheringHint = [string]$telemetry.tetheringHint
      error = [string]$payload.error
      message = [string]$payload.message
    }
  } catch {
    $results += [pscustomobject]@{
      routerId = $router.id
      host = $router.host
      ok = $false
      mode = ""
      uplinkMode = ""
      tetheringState = ""
      publicIp = ""
      usbPorts = ""
      tetheringHint = ""
      error = $_.Exception.Message
      message = "Router health probe failed."
    }
  }
}

if ($AsJson) {
  $results | ConvertTo-Json -Depth 4
} else {
  $results | Sort-Object routerId | Format-Table -AutoSize
}
