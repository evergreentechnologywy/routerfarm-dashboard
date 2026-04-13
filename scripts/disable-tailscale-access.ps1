param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\settings.json"
$startScript = Join-Path $root "start-routerfarm.ps1"
$stopScript = Join-Path $root "stop-routerfarm.ps1"

if (-not (Test-Path $settingsPath)) {
  throw "settings.json not found at $settingsPath"
}

$settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
$settings.host = "127.0.0.1"
$settings | ConvertTo-Json -Depth 8 | Set-Content -Path $settingsPath

if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  tailscale serve --http=$($settings.port) off | Out-Null
}

powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Null
Start-Sleep -Seconds 1
powershell -NoProfile -ExecutionPolicy Bypass -File $startScript | Out-Null

Write-Output "RouterFarm is now localhost-only on http://127.0.0.1:$($settings.port)/"
