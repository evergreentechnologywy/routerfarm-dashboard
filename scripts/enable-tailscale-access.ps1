param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\settings.json"
$startScript = Join-Path $root "start-routerfarm.ps1"
$stopScript = Join-Path $root "stop-routerfarm.ps1"

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  throw "tailscale.exe is not installed."
}

$status = tailscale status --json | ConvertFrom-Json
if (-not $status.Self -or -not $status.Self.Online) {
  throw "Tailscale is not online on this machine."
}

if (-not (Test-Path $settingsPath)) {
  throw "settings.json not found at $settingsPath"
}

$settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
$settings.host = "127.0.0.1"
$settings | ConvertTo-Json -Depth 8 | Set-Content -Path $settingsPath

powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Null
Start-Sleep -Seconds 1
powershell -NoProfile -ExecutionPolicy Bypass -File $startScript | Out-Null

$target = "http://127.0.0.1:$($settings.port)"
tailscale serve --bg --http $settings.port $target | Out-Null

$dnsName = if ($status.Self.DNSName) { $status.Self.DNSName.TrimEnd('.') } else { "" }

Write-Output "RouterFarm remains bound to localhost only: $target"
if ($dnsName) {
  Write-Output "Tailscale remote URL: http://$dnsName`:$($settings.port)/"
} else {
  Write-Output "Tailscale remote URL uses this node's tailnet DNS or IP on port $($settings.port)."
}
Write-Output "This exposes only the dashboard access path over Tailscale. It does not route phone browsing traffic through the PC."
