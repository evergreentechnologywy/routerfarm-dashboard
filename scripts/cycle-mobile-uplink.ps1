param(
  [Parameter(Mandatory = $true)]
  [string]$RouterId,

  [int]$PowerCycleSeconds = 12,

  [string]$RoutersPath,
  [string]$SettingsPath
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

$delegateScript = Join-Path $scriptRoot "invoke-routerfarm-router-action.ps1"
$result = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $delegateScript `
  -RouterId $RouterId `
  -Action "usb-tether-reset" `
  -RoutersPath $RoutersPath `
  -SettingsPath $SettingsPath

$payload = $null
try {
  $payload = $result | ConvertFrom-Json -ErrorAction Stop
} catch {
  $payload = $null
}

if (-not $payload) {
  $fallback = @{
    ok = $false
    routerId = $RouterId
    action = "cycle-mobile-uplink"
    message = "USB uplink cycle did not return a valid payload."
    detail = [string]($result | Out-String).Trim()
    checkedAt = [DateTime]::UtcNow.ToString("o")
  }
  $fallback | ConvertTo-Json -Depth 8 -Compress
  exit 1
}

$normalized = @{}
foreach ($prop in $payload.PSObject.Properties) {
  $normalized[$prop.Name] = $prop.Value
}
$normalized.action = "cycle-mobile-uplink"
$normalized.recommendedDelaySeconds = $PowerCycleSeconds
$normalized | ConvertTo-Json -Depth 8 -Compress
exit $(if ($payload.ok) { 0 } else { 1 })
