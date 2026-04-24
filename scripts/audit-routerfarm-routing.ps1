param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $root "config\routing-audit.json"
$dashboardPort = 7781
$routerFarmHost = "127.0.0.1"

try {
  $settingsPath = Join-Path $root "config\settings.json"
  if (Test-Path $settingsPath) {
    $settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
    if ($settings.port) { $dashboardPort = [int]$settings.port }
    if ($settings.host) { $routerFarmHost = [string]$settings.host }
  }
} catch {}

function New-Check {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail
  )

  [pscustomobject]@{
    name = $Name
    ok = $Ok
    detail = $Detail
  }
}

$checks = @()
$checks += New-Check -Name "RouterFarm Bind Mode" -Ok ($routerFarmHost -eq "127.0.0.1") -Detail "RouterFarm host binding: $routerFarmHost"

try {
  $tailscaleCommand = Get-Command tailscale -ErrorAction SilentlyContinue
  $tailscaleExe = if ($tailscaleCommand) { $tailscaleCommand.Source } else { "C:\Program Files\Tailscale\tailscale.exe" }
  $tailscale = & $tailscaleExe status --json | ConvertFrom-Json
  $exitNode = [bool]$tailscale.Self.ExitNode
  $checks += New-Check -Name "Tailscale Exit Node" -Ok (-not $exitNode) -Detail (if ($exitNode) { "This PC is configured as an exit node." } else { "This PC is not using exit-node mode." })
}
catch {
  $checks += New-Check -Name "Tailscale Exit Node" -Ok $true -Detail "Tailscale status unavailable; no exit-node evidence from audit."
}

try {
  $tailscaleCommand = Get-Command tailscale -ErrorAction SilentlyContinue
  $tailscaleExe = if ($tailscaleCommand) { $tailscaleCommand.Source } else { "C:\Program Files\Tailscale\tailscale.exe" }
  $tailscale = & $tailscaleExe status --json | ConvertFrom-Json
  $serve = & $tailscaleExe serve status --json | ConvertFrom-Json
  $dnsName = if ($tailscale.Self.DNSName) { $tailscale.Self.DNSName.TrimEnd('.') } else { "" }
  $serveProxy = ""
  if ($dnsName -and $serve.Web) {
    $serveKey = "$dnsName`:$dashboardPort"
    $webEntry = $serve.Web.PSObject.Properties | Where-Object { $_.Name -eq $serveKey } | Select-Object -First 1
    if ($webEntry -and $webEntry.Value.Handlers -and $webEntry.Value.Handlers."/".Proxy) {
      $serveProxy = $webEntry.Value.Handlers."/".Proxy
    }
  }
  $expectedProxy = "http://127.0.0.1:$dashboardPort"
  $checks += New-Check -Name "Tailscale Dashboard Exposure" -Ok ($serveProxy -eq $expectedProxy) -Detail (if ($serveProxy) { "Tailscale serve proxy for RouterFarm: $serveProxy" } else { "No Tailscale serve mapping found for RouterFarm on port $dashboardPort." })
}
catch {
  $checks += New-Check -Name "Tailscale Dashboard Exposure" -Ok $false -Detail "Could not verify the Tailscale serve mapping for RouterFarm."
}

try {
  $sharedAccess = Get-Service -Name SharedAccess -ErrorAction Stop
  $icsOff = $sharedAccess.Status -ne "Running"
  $checks += New-Check -Name "Internet Connection Sharing" -Ok $icsOff -Detail "SharedAccess service status: $($sharedAccess.Status)"
}
catch {
  $checks += New-Check -Name "Internet Connection Sharing" -Ok $true -Detail "SharedAccess service not present or not queryable."
}

try {
  $winHttp = netsh winhttp show proxy | Out-String
  $direct = $winHttp -match "Direct access"
  $checks += New-Check -Name "WinHTTP Proxy" -Ok $direct -Detail (($winHttp -replace '\s+', ' ').Trim())
}
catch {
  $checks += New-Check -Name "WinHTTP Proxy" -Ok $false -Detail "Could not query WinHTTP proxy state."
}

try {
  $internetSettings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
  $proxyEnabled = [int]($internetSettings.ProxyEnable | ForEach-Object { $_ }) -eq 1
  $detail = if ($proxyEnabled) { "User proxy enabled: $($internetSettings.ProxyServer)" } else { "User proxy disabled." }
  $checks += New-Check -Name "Windows User Proxy" -Ok (-not $proxyEnabled) -Detail $detail
}
catch {
  $checks += New-Check -Name "Windows User Proxy" -Ok $true -Detail "User proxy settings unavailable."
}

try {
  $pcPublicIp = (Invoke-WebRequest -UseBasicParsing -Uri "https://api64.ipify.org?format=text" -TimeoutSec 8).Content.Trim()
  $checks += New-Check -Name "PC Public IP" -Ok ([bool]$pcPublicIp) -Detail "PC public IP from the PC-side path: $pcPublicIp"
}
catch {
  $checks += New-Check -Name "PC Public IP" -Ok $false -Detail "Could not retrieve the PC public IP for comparison."
}

try {
  $query = reg query HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters /v IPEnableRouter 2>$null | Out-String
  $match = [regex]::Match($query, 'IPEnableRouter\s+REG_DWORD\s+0x([0-9a-fA-F]+)')
  $ipEnableRouter = if ($match.Success) { [Convert]::ToInt32($match.Groups[1].Value, 16) } else { 0 }
  $checks += New-Check -Name "IPv4 Forwarding" -Ok ($ipEnableRouter -eq 0) -Detail (if ($ipEnableRouter -eq 0) { "Global IP forwarding is disabled." } else { "Global IP forwarding is enabled via IPEnableRouter." })
}
catch {
  $checks += New-Check -Name "IPv4 Forwarding" -Ok $false -Detail "Could not query IPv4 forwarding state."
}

$overallOk = -not ($checks | Where-Object { -not $_.ok })
$result = [pscustomobject]@{
  checkedAt = (Get-Date).ToString("o")
  overallOk = $overallOk
  summary = if ($overallOk) { "No obvious PC gateway or proxy routing flags detected." } else { "One or more routing or proxy checks need attention." }
  dashboardAccessPath = "Operator -> Tailscale -> localhost RouterFarm dashboard on this PC"
  deviceTrafficPath = "Phone -> assigned router -> mobile uplink -> website"
  checks = $checks
}

$result | ConvertTo-Json -Depth 6 | Set-Content -Path $outputPath -Encoding utf8NoBOM
Write-Output $result.summary
