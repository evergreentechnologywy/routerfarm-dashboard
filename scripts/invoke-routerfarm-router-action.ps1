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
  "reboot-router" = "reboot"
  "restart-wifi" = "wifi reload"
  "wan-reconnect" = "ifup wan || /etc/init.d/network restart"
  "usb-tether-reset" = "ifdown wan; sleep 2; ifup wan"
}

$routerCommand = $commandMap[$Action]
if (-not $routerCommand) {
  Write-Result -Success:$false -Message "Unsupported router action '$Action'."
  exit 1
}

$sshArgs = @("-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes", "-p", "$sshPort")
if ($router.sshKeyPath) {
  $sshArgs += @("-i", [string]$router.sshKeyPath)
}
$sshArgs += @("$username@$routerHost", $routerCommand)

try {
  $result = & $sshPath @sshArgs 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Write-Result -Success:$false -Message "SSH command failed." -Extra @{
      host = $routerHost
      exitCode = $exitCode
      detail = [string]($result | Out-String).Trim()
      requiresConfiguration = $true
    }
    exit 1
  }

  Write-Result -Success:$true -Message "Router action completed." -Extra @{
    host = $routerHost
    detail = [string]($result | Out-String).Trim()
  }
  exit 0
} catch {
  Write-Result -Success:$false -Message $_.Exception.Message -Extra @{
    host = $routerHost
    requiresConfiguration = $true
  }
  exit 1
}
