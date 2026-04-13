param(
  [Parameter(Mandatory = $true)]
  [string]$RouterId,

  [Parameter(Mandatory = $true)]
  [string]$Action,

  [string]$RoutersPath = "C:\RouterFarm\config\routers.json",
  [string]$SettingsPath = "C:\RouterFarm\config\settings.json"
)

$ErrorActionPreference = "Stop"

function Write-Result {
  param(
    [bool]$Success,
    [string]$Message,
    [hashtable]$Extra = @{}
  )

  $payload = @{
    ok = $Success
    routerId = $RouterId
    action = $Action
    message = $Message
    checkedAt = [DateTime]::UtcNow.ToString("o")
  }

  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }

  $payload | ConvertTo-Json -Depth 6 -Compress
}

function Invoke-SshCommand {
  param([string]$Command)

  $sshArgs = @(
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=$commandTimeout",
    "-o", "HostKeyAlgorithms=+ssh-rsa",
    "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
    "-p", "$sshPort"
  )
  if ($router.sshKeyPath) {
    $sshArgs += @("-i", [string]$router.sshKeyPath)
  }
  $sshArgs += @("$username@$routerHost", $Command)

  try {
    $result = & $sshPath @sshArgs 2>&1
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{
      ExitCode = $exitCode
      Output = [string]($result | Out-String).Trim()
    }
  } catch {
    return [pscustomobject]@{
      ExitCode = 1
      Output = $_.Exception.Message
    }
  }
}

if (-not (Test-Path -LiteralPath $RoutersPath)) {
  Write-Result -Success:$false -Message "Routers config was not found." 
  exit 1
}

$routersConfig = Get-Content -LiteralPath $RoutersPath -Raw | ConvertFrom-Json
$settings = if (Test-Path -LiteralPath $SettingsPath) {
  Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
} else {
  $null
}

$router = @($routersConfig.routers) | Where-Object { $_.id -eq $RouterId } | Select-Object -First 1
if (-not $router) {
  Write-Result -Success:$false -Message "Router '$RouterId' was not found."
  exit 1
}

$sshPath = if ($settings.routerControl.sshPath) { [string]$settings.routerControl.sshPath } else { "ssh" }
$username = if ($router.adminUsername) { [string]$router.adminUsername } elseif ($settings.routerControl.defaultUsername) { [string]$settings.routerControl.defaultUsername } else { "root" }
$sshPort = if ($router.sshPort) { [int]$router.sshPort } elseif ($settings.routerControl.defaultPort) { [int]$settings.routerControl.defaultPort } else { 22 }
$commandTimeout = if ($settings.routerControl.commandTimeoutSeconds) { [int]$settings.routerControl.commandTimeoutSeconds } else { 25 }

$routerHost = [string]$router.host
if ([string]::IsNullOrWhiteSpace($routerHost)) {
  Write-Result -Success:$false -Message "Router host is not configured." -Extra @{ requiresConfiguration = $true }
  exit 1
}

$commandMap = @{
  "router-health" = "ubus call system board"
  "reboot-router" = "sh -c '(sleep 1; reboot) >/dev/null 2>&1 &'"
  "restart-wifi" = "wifi reload"
  "wan-reconnect" = "ifup wan || /etc/init.d/network restart"
  "usb-tether-reset" = "ifdown wan; sleep 2; ifup wan"
}

$routerCommand = $commandMap[$Action]
if (-not $routerCommand) {
  Write-Result -Success:$false -Message "Unsupported router action '$Action'."
  exit 1
}

$telemetryCommands = @{
  "board" = "ubus call system board"
  "wan" = "ifstatus wan"
  "wwan" = "ifstatus wwan"
  "route" = "ip route"
  "networkConfig" = "cat /etc/config/network"
  "publicIp" = "sh -c 'if command -v curl >/dev/null 2>&1; then curl -fsSL https://api.ipify.org; elif command -v uclient-fetch >/dev/null 2>&1; then uclient-fetch -qO- https://api.ipify.org; elif command -v wget >/dev/null 2>&1; then wget -qO- https://api.ipify.org; else echo no-http-client; fi'"
}

if ($Action -eq "router-health") {
  $boardResult = Invoke-SshCommand -Command $telemetryCommands.board
  $wanResult = Invoke-SshCommand -Command $telemetryCommands.wan
  $wwanResult = Invoke-SshCommand -Command $telemetryCommands.wwan
  $routeResult = Invoke-SshCommand -Command $telemetryCommands.route
  $networkConfigResult = Invoke-SshCommand -Command $telemetryCommands.networkConfig
  $publicIpResult = Invoke-SshCommand -Command $telemetryCommands.publicIp

  if ($boardResult.ExitCode -ne 0) {
    Write-Result -Success:$false -Message "SSH command failed." -Extra @{
      host = $routerHost
      exitCode = $boardResult.ExitCode
      detail = $boardResult.Output
      requiresConfiguration = $true
      telemetry = @{
        board = $boardResult.Output
        wan = $wanResult.Output
        wwan = $wwanResult.Output
        route = $routeResult.Output
        networkConfig = $networkConfigResult.Output
        publicIp = $publicIpResult.Output
      }
    }
    exit 1
  }

  $wanJson = $null
  $wwanJson = $null
  try {
    $wanJson = $wanResult.Output | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $wanJson = $null
  }
  try {
    $wwanJson = $wwanResult.Output | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $wwanJson = $null
  }

  $publicIp = ($publicIpResult.Output -split '\r?\n' | Select-Object -First 1).Trim()
  if ($publicIp -eq "no-http-client") {
    $publicIp = ""
  }

  $wanUp = $false
  $wanAddress = ""
  $wanDevice = ""
  $uplinkInterface = ""
  $uplinkMode = "unknown"
  $uplinkRaw = ""

  if ($wwanJson -and -not $wwanJson.errors) {
    $wanUp = [bool]$wwanJson.up
    $wanDevice = [string]$wwanJson.device
    $firstIpv4 = @($wwanJson."ipv4-address")[0]
    if ($firstIpv4 -and $firstIpv4.address) {
      $wanAddress = [string]$firstIpv4.address
    }
    $uplinkInterface = "wwan"
    $uplinkMode = "router-uplink"
    $uplinkRaw = $wwanResult.Output
  } elseif ($wanJson -and -not $wanJson.errors) {
    $wanUp = [bool]$wanJson.up
    $wanDevice = [string]$wanJson.device
    $firstIpv4 = @($wanJson."ipv4-address")[0]
    if ($firstIpv4 -and $firstIpv4.address) {
      $wanAddress = [string]$firstIpv4.address
    }
    $uplinkInterface = "wan"
    $uplinkMode = "router-uplink"
    $uplinkRaw = $wanResult.Output
  } else {
    $uplinkInterface = "lan"
    $uplinkMode = "bridge-or-ap"
    $uplinkRaw = $routeResult.Output
  }

  Write-Result -Success:$true -Message "Router health probe completed." -Extra @{
    host = $routerHost
    detail = $boardResult.Output
    telemetry = @{
      board = $boardResult.Output
      wan = $wanResult.Output
      wwan = $wwanResult.Output
      route = $routeResult.Output
      networkConfig = $networkConfigResult.Output
      publicIp = $publicIp
      wanUp = $wanUp
      wanAddress = $wanAddress
      wanDevice = $wanDevice
      uplinkInterface = $uplinkInterface
      uplinkMode = $uplinkMode
      uplinkRaw = $uplinkRaw
    }
  }
  exit 0
}

$result = Invoke-SshCommand -Command $routerCommand
if ($result.ExitCode -ne 0) {
  Write-Result -Success:$false -Message "SSH command failed." -Extra @{
    host = $routerHost
    exitCode = $result.ExitCode
    detail = $result.Output
    requiresConfiguration = $true
  }
  exit 1
}

Write-Result -Success:$true -Message "Router action completed." -Extra @{
  host = $routerHost
  detail = $result.Output
}
exit 0
