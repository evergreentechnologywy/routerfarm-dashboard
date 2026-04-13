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

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

$settings = Get-Settings
$baseUrl = "http://$($settings.host):$($settings.port)"

$index = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/" -TimeoutSec 10
$buildMatch = [regex]::Match($index.Content, 'Build\s+([0-9a-z]+)')
$assetVersionMatch = [regex]::Match($index.Content, 'app\.js\?v=([0-9a-z]+)')
$build = if ($buildMatch.Success) { $buildMatch.Groups[1].Value } else { "" }
$assetVersion = if ($assetVersionMatch.Success) { $assetVersionMatch.Groups[1].Value } else { $build }

$stylesPath = if ($assetVersion) { "$baseUrl/styles.css?v=$assetVersion" } else { "$baseUrl/styles.css" }
$appPath = if ($assetVersion) { "$baseUrl/app.js?v=$assetVersion" } else { "$baseUrl/app.js" }

$styles = Invoke-WebRequest -UseBasicParsing -Uri $stylesPath -TimeoutSec 10
$app = Invoke-WebRequest -UseBasicParsing -Uri $appPath -TimeoutSec 10
$me = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/me" -TimeoutSec 10 | Select-Object -ExpandProperty Content | ConvertFrom-Json
$status = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/status" -TimeoutSec 15 | Select-Object -ExpandProperty Content | ConvertFrom-Json

Assert-True ($index.StatusCode -eq 200) "Dashboard index did not return HTTP 200."
Assert-True (-not [string]::IsNullOrWhiteSpace($build)) "Dashboard HTML does not contain a build string."
Assert-True ($styles.StatusCode -eq 200) "Dashboard stylesheet did not return HTTP 200."
Assert-True ($app.StatusCode -eq 200) "Dashboard app.js did not return HTTP 200."
Assert-True ($me.ok -eq $true) "/api/me did not return ok=true."
Assert-True ($status.ok -eq $true) "/api/status did not return ok=true."
Assert-True ($null -ne $status.routingAudit) "/api/status is missing routingAudit."
Assert-True ($null -ne $status.routingGuard) "/api/status is missing routingGuard."
Assert-True ($null -ne $status.prepTelemetry) "/api/status is missing prepTelemetry."
Assert-True ($null -ne $status.devices) "/api/status is missing devices."

[pscustomobject]@{
  BaseUrl = $baseUrl
  Build = $build
  Devices = @($status.devices).Count
  RoutingBlocked = [bool]$status.routingGuard.blocked
  ActivePrep = if ($status.prepTelemetry.active) { $status.prepTelemetry.active.label } else { "" }
  LastCompletedPrep = if ($status.prepTelemetry.lastCompleted) { $status.prepTelemetry.lastCompleted.label } else { "" }
} | Format-List
