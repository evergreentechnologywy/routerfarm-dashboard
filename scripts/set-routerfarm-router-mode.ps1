param(
  [Parameter(Mandatory = $true)]
  [string]$RouterId,

  [Parameter(Mandatory = $true)]
  [ValidateSet("router", "ap", "repeater", "stabridge")]
  [string]$Mode,

  [string]$RoutersPath,
  [string]$SettingsPath,
  [switch]$SkipBackup
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

function Write-Result {
  param(
    [bool]$Success,
    [string]$Message,
    [hashtable]$Extra = @{}
  )

  $payload = @{
    ok = $Success
    routerId = $RouterId
    mode = $Mode
    message = $Message
    checkedAt = [DateTime]::UtcNow.ToString("o")
  }
  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }
  $payload | ConvertTo-Json -Depth 8 -Compress
}

$routersConfig = Get-Content -LiteralPath $RoutersPath -Raw | ConvertFrom-Json
$settings = if (Test-Path -LiteralPath $SettingsPath) { Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json } else { $null }
$router = @($routersConfig.routers) | Where-Object { $_.id -eq $RouterId } | Select-Object -First 1
if (-not $router) {
  Write-Result -Success:$false -Message "Router '$RouterId' was not found."
  exit 1
}

$sshPath = if ($settings.routerControl.sshPath) { [string]$settings.routerControl.sshPath } else { "ssh" }
$username = if ($router.adminUsername) { [string]$router.adminUsername } elseif ($settings.routerControl.defaultUsername) { [string]$settings.routerControl.defaultUsername } else { "root" }
$sshPort = if ($router.sshPort) { [int]$router.sshPort } elseif ($settings.routerControl.defaultPort) { [int]$settings.routerControl.defaultPort } else { 22 }
$routerHost = [string]$router.host
if ([string]::IsNullOrWhiteSpace($routerHost)) {
  Write-Result -Success:$false -Message "Router host is not configured."
  exit 1
}

if ($Mode -eq "router") {
  $backupPath = "/tmp/routerfarm-pre-router-$(Get-Date -Format 'yyyyMMdd-HHmmss').tgz"
  $remoteCommand = @(
    "set -e"
    "if [ '$($SkipBackup.IsPresent.ToString().ToLower())' != 'true' ]; then tar -czf '$backupPath' /etc/config/network /etc/config/wireless /etc/config/firewall /etc/config/glconfig >/dev/null 2>&1 || true; fi"
    "sh /etc/gl-reset-network.d/reset-netmode >/tmp/routerfarm-reset-netmode.log 2>&1 || cat /tmp/routerfarm-reset-netmode.log"
    "sleep 3"
    "uci -q get glconfig.general.mode"
  ) -join "; "

  $sshArgs = @(
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "HostKeyAlgorithms=+ssh-rsa",
    "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
    "-p", "$sshPort",
    "$username@$routerHost",
    $remoteCommand
  )

  try {
    $output = & $sshPath @sshArgs 2>&1
    $exitCode = $LASTEXITCODE
    $text = [string]($output | Out-String).Trim()
    if ($exitCode -ne 0) {
      Write-Result -Success:$false -Message "Router mode change failed." -Extra @{ host = $routerHost; detail = $text; backupPath = $backupPath; method = "reset-netmode" }
      exit 1
    }

    $lines = @($text -split '\r?\n' | Where-Object { $_.Trim() })
    $reportedMode = if ($lines.Count) { $lines[-1].Trim() } else { "" }
    Write-Result -Success:($reportedMode -eq $Mode) -Message "Router mode change requested." -Extra @{
      host = $routerHost
      reportedMode = $reportedMode
      detail = $text
      backupPath = $backupPath
      method = "reset-netmode"
    }
    exit 0
  } catch {
    Write-Result -Success:$false -Message "Router mode change failed." -Extra @{ host = $routerHost; detail = $_.Exception.Message; backupPath = $backupPath; method = "reset-netmode" }
    exit 1
  }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "/tmp/routerfarm-pre-$Mode-$timestamp.tgz"
$remotePayloadPath = "/tmp/routerfarm-netmode-$timestamp.json"
$rpcPayload = '{"jsonrpc":"2.0","method":"call","params":["","netmode","set_mode",{"mode":"__MODE__"}],"id":1}'.Replace("__MODE__", $Mode)

$remoteCommand = @(
  "set -e"
  "printf '%s' '$rpcPayload' > '$remotePayloadPath'"
  "if [ '$($SkipBackup.IsPresent.ToString().ToLower())' != 'true' ]; then tar -czf '$backupPath' /etc/config/network /etc/config/wireless /etc/config/firewall /etc/config/glconfig >/dev/null 2>&1 || true; fi"
  "curl -H 'glinet: 1' -H 'Content-Type: application/json' -s -k http://127.0.0.1/rpc --data-binary '@$remotePayloadPath'"
  "sleep 3"
  "uci -q get glconfig.general.mode"
) -join "; "

$sshArgs = @(
  "-o", "StrictHostKeyChecking=no",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=5",
  "-o", "HostKeyAlgorithms=+ssh-rsa",
  "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
  "-p", "$sshPort",
  "$username@$routerHost",
  $remoteCommand
)

try {
  $output = & $sshPath @sshArgs 2>&1
  $exitCode = $LASTEXITCODE
  $text = [string]($output | Out-String).Trim()
  if ($exitCode -ne 0) {
    Write-Result -Success:$false -Message "Router mode change failed." -Extra @{ host = $routerHost; detail = $text; backupPath = $backupPath; payloadPath = $remotePayloadPath }
    exit 1
  }

  $lines = @($text -split '\r?\n' | Where-Object { $_.Trim() })
  $reportedMode = if ($lines.Count) { $lines[-1].Trim() } else { "" }
  Write-Result -Success:($reportedMode -eq $Mode) -Message "Router mode change requested." -Extra @{
    host = $routerHost
    reportedMode = $reportedMode
    detail = $text
    backupPath = $backupPath
    payloadPath = $remotePayloadPath
  }
  exit 0
} catch {
  Write-Result -Success:$false -Message "Router mode change failed." -Extra @{ host = $routerHost; detail = $_.Exception.Message; backupPath = $backupPath; payloadPath = $remotePayloadPath }
  exit 1
}
