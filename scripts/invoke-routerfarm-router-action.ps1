param(
  [Parameter(Mandatory = $true)]
  [string]$RouterId,

  [Parameter(Mandatory = $true)]
  [string]$Action,

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
  param(
    [string]$Command,
    [string]$StdinPath
  )

  if ($usePlink) {
    $plinkArgs = @(
      "-ssh",
      "-batch",
      "-pw", $routerPassword,
      "-hostkey", $routerHostKey,
      "-P", "$sshPort",
      "$username@$routerHost"
    )
    if ($Command) {
      $plinkArgs += $Command
    }

    try {
      $result = if ($StdinPath) {
        Get-Content -LiteralPath $StdinPath | & $sshPath @plinkArgs 2>&1
      } else {
        & $sshPath @plinkArgs 2>&1
      }
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
    $result = if ($StdinPath) {
      Get-Content -LiteralPath $StdinPath | & $sshPath @sshArgs 2>&1
    } else {
      & $sshPath @sshArgs 2>&1
    }
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

function Invoke-RouterLuaModule {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ModulePath,

    [Parameter(Mandatory = $true)]
    [string]$Expression
  )

  $tempPath = [System.IO.Path]::GetTempFileName()
  try {
    $luaScript = @"
local cjson = require("cjson")
local module = dofile("$ModulePath")
local result = $Expression
if result == nil then
  print("null")
else
  print(cjson.encode(result))
end
"@
    Set-Content -LiteralPath $tempPath -Value $luaScript -NoNewline
    return Invoke-SshCommand -Command "cat >/tmp/routerfarm-rpc.lua; lua /tmp/routerfarm-rpc.lua" -StdinPath $tempPath
  } finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
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
$passwordEnvVar = if ($router.adminPasswordEnvVar) { [string]$router.adminPasswordEnvVar } elseif ($settings.routerControl.defaultPasswordEnvVar) { [string]$settings.routerControl.defaultPasswordEnvVar } else { "" }
$routerPassword = if ($passwordEnvVar) { [Environment]::GetEnvironmentVariable($passwordEnvVar, "Process") } else { "" }
if (-not $routerPassword -and $passwordEnvVar) {
  $routerPassword = [Environment]::GetEnvironmentVariable($passwordEnvVar, "User")
}
if (-not $routerPassword -and $passwordEnvVar) {
  $routerPassword = [Environment]::GetEnvironmentVariable($passwordEnvVar, "Machine")
}

$routerHost = [string]$router.host
if ([string]::IsNullOrWhiteSpace($routerHost)) {
  Write-Result -Success:$false -Message "Router host is not configured." -Extra @{ requiresConfiguration = $true }
  exit 1
}

$plinkCommand = Get-Command "plink.exe" -ErrorAction SilentlyContinue
$routerHostKey = ""
if ($router.sshHostKey) {
  $routerHostKey = [string]$router.sshHostKey
} elseif ($settings.routerControl.defaultHostKeys) {
  $hostKeyProperty = $settings.routerControl.defaultHostKeys.PSObject.Properties[$routerHost]
  if ($hostKeyProperty) {
    $routerHostKey = [string]$hostKeyProperty.Value
  }
}
$usePlink = [bool]($routerPassword -and $plinkCommand -and $routerHostKey)
if ($usePlink) {
  $sshPath = $plinkCommand.Source
}

$commandMap = @{
  "router-health" = "ubus call system board"
  "reboot-router" = "sh -c '(sleep 1; reboot) >/dev/null 2>&1 &'"
  "restart-wifi" = "wifi reload"
  "wan-reconnect" = "ifup wan || /etc/init.d/network restart"
  "usb-tether-reset" = @'
sh -c '
get_public_ip() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 5 --max-time 8 https://api.ipify.org 2>/dev/null || true
  elif command -v uclient-fetch >/dev/null 2>&1; then
    uclient-fetch -qO- https://api.ipify.org 2>/dev/null || true
  elif command -v wget >/dev/null 2>&1; then
    wget -T 8 -qO- https://api.ipify.org 2>/dev/null || true
  fi
}
tether_json="$(ifstatus tethering 2>/dev/null || true)"
iface="$(printf "%s" "$tether_json" | jsonfilter -e "@.l3_device" 2>/dev/null || true)"
[ -n "$iface" ] || iface="$(printf "%s" "$tether_json" | jsonfilter -e "@.device" 2>/dev/null || true)"
model="$(cat /proc/gl-hw-info/model 2>/dev/null || true)"
before_ip="$(get_public_ip)"
if [ "$model" = "sft1200" ]; then
  ifdown tethering >/dev/null 2>&1 || true
  sleep 4
  ifup tethering >/dev/null 2>&1 || true
  sleep 6
elif [ -n "$iface" ] && [ -e "/sys/class/net/$iface/device/driver/unbind" ]; then
  devnode="$(basename "$(readlink -f "/sys/class/net/$iface/device")")"
  drvpath="$(readlink -f "/sys/class/net/$iface/device/driver")"
  printf "%s" "$devnode" > "$drvpath/unbind"
  sleep 4
  printf "%s" "$devnode" > "$drvpath/bind"
  sleep 6
else
  ifdown tethering >/dev/null 2>&1 || true
  sleep 4
  ifup tethering >/dev/null 2>&1 || true
  sleep 6
fi
ifup tethering >/dev/null 2>&1 || true
sleep 8
after_ip="$(get_public_ip)"
echo "BEFORE_PUBLIC_IP=$before_ip"
echo "AFTER_PUBLIC_IP=$after_ip"
ifstatus tethering 2>/dev/null || true
'
'@
}

$routerCommand = $commandMap[$Action]
if (-not $routerCommand) {
  Write-Result -Success:$false -Message "Unsupported router action '$Action'."
  exit 1
}

$telemetryCommands = @{
  "board" = "ubus call system board"
  "mode" = "uci -q get glconfig.general.mode"
  "wan" = "ifstatus wan"
  "wwan" = "ifstatus wwan"
  "route" = "ip route"
  "networkConfig" = "cat /etc/config/network"
  "publicIp" = "sh -c 'if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 5 --max-time 8 https://api.ipify.org; elif command -v uclient-fetch >/dev/null 2>&1; then uclient-fetch -qO- https://api.ipify.org; elif command -v wget >/dev/null 2>&1; then wget -T 8 -qO- https://api.ipify.org; else echo no-http-client; fi'"
  "usbDevices" = "cat /sys/kernel/debug/usb/devices 2>/dev/null"
  "usbPorts" = "cat /proc/gl-hw-info/usb-port 2>/dev/null"
}

if ($Action -eq "router-health") {
  $boardResult = Invoke-SshCommand -Command $telemetryCommands.board
  $modeResult = Invoke-SshCommand -Command $telemetryCommands.mode
  $wanResult = Invoke-SshCommand -Command $telemetryCommands.wan
  $wwanResult = Invoke-SshCommand -Command $telemetryCommands.wwan
  $routeResult = Invoke-SshCommand -Command $telemetryCommands.route
  $networkConfigResult = Invoke-SshCommand -Command $telemetryCommands.networkConfig
  $publicIpResult = Invoke-SshCommand -Command $telemetryCommands.publicIp
  $usbDevicesResult = Invoke-SshCommand -Command $telemetryCommands.usbDevices
  $usbPortsResult = Invoke-SshCommand -Command $telemetryCommands.usbPorts
  $tetheringResult = Invoke-RouterLuaModule -ModulePath "/usr/lib/oui-httpd/rpc/tethering" -Expression 'module.get_status({})'

  if ($boardResult.ExitCode -ne 0) {
    Write-Result -Success:$false -Message "SSH command failed." -Extra @{
      host = $routerHost
      exitCode = $boardResult.ExitCode
      detail = $boardResult.Output
      requiresConfiguration = $true
      telemetry = @{
        board = $boardResult.Output
        mode = $modeResult.Output
        wan = $wanResult.Output
        wwan = $wwanResult.Output
        route = $routeResult.Output
        networkConfig = $networkConfigResult.Output
        publicIp = $publicIpResult.Output
        usbDevices = $usbDevicesResult.Output
        usbPorts = $usbPortsResult.Output
        tethering = $tetheringResult.Output
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
  $routerMode = ($modeResult.Output -split '\r?\n' | Select-Object -First 1).Trim()
  if ($publicIp -eq "no-http-client") {
    $publicIp = ""
  }

  $tetheringJson = $null
  try {
    $tetheringJson = $tetheringResult.Output | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $tetheringJson = $null
  }

  $tetheringState = "unknown"
  $tetheringError = ""
  $tetheringHint = ""
  $tetheringDevice = ""
  $tetheringAddress = ""
  $tetheringInUse = $false
  if ($tetheringJson -and $tetheringJson.err_code -eq -2) {
    $tetheringState = "no-device"
    $tetheringError = [string]$tetheringJson.err_msg
    $tetheringHint = "Router does not detect a USB uplink device. Verify the LinkPro USB mode is set for Internet access and the cable supports data, not power only."
  } elseif ($tetheringJson -and $tetheringJson.err_msg) {
    $tetheringState = "error"
    $tetheringError = [string]$tetheringJson.err_msg
  } elseif ($tetheringJson) {
    if ($tetheringJson.device) {
      $tetheringDevice = [string]$tetheringJson.device
    } elseif ($tetheringJson.l3_device) {
      $tetheringDevice = [string]$tetheringJson.l3_device
    } elseif (@($tetheringJson.devices).Count -gt 0) {
      $primaryTetherDevice = @($tetheringJson.devices) | Select-Object -First 1
      if ($primaryTetherDevice -and $primaryTetherDevice.device) {
        $tetheringDevice = [string]$primaryTetherDevice.device
      }
    }

    $tetheringIpv4 = $tetheringJson.ipv4
    if (-not $tetheringIpv4) {
      $tetheringIpv4 = @($tetheringJson."ipv4-address")[0]
    }
    if ($tetheringIpv4) {
      if ($tetheringIpv4.ip) {
        $tetheringAddress = [string]$tetheringIpv4.ip
      } elseif ($tetheringIpv4.address) {
        $tetheringAddress = [string]$tetheringIpv4.address
      }
    }

    $tetheringInUse = [bool](
      ($tetheringJson.status -eq 1) -or
      ($tetheringJson.up -eq $true) -or
      ((@($tetheringJson.devices) | Where-Object { $_.use -eq $true }).Count -gt 0)
    )

    if ($tetheringInUse) {
      $tetheringState = "connected"
    } elseif (($tetheringJson.device) -or (@($tetheringJson.devices).Count -gt 0)) {
      $tetheringState = "detected"
    }
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
  } elseif ($tetheringInUse) {
    $wanUp = $true
    $wanDevice = $tetheringDevice
    $wanAddress = $tetheringAddress
    $uplinkInterface = if ($tetheringDevice) { $tetheringDevice } else { "tethering" }
    $uplinkMode = "router-uplink"
    $uplinkRaw = $tetheringResult.Output
  } else {
    $uplinkInterface = "lan"
    $uplinkMode = "bridge-or-ap"
    $uplinkRaw = $routeResult.Output
  }

  if ($routerMode -notin @("ap", "router")) {
    if ($tetheringState -eq "detected" -or $uplinkMode -eq "router-uplink") {
      $routerMode = "router"
    } elseif ($uplinkMode -eq "bridge-or-ap") {
      $routerMode = "ap"
    } else {
      $routerMode = ""
    }
  }

  Write-Result -Success:$true -Message "Router health probe completed." -Extra @{
    host = $routerHost
    detail = $boardResult.Output
    telemetry = @{
      board = $boardResult.Output
      mode = $routerMode
      wan = $wanResult.Output
      wwan = $wwanResult.Output
      route = $routeResult.Output
      networkConfig = $networkConfigResult.Output
      publicIp = $publicIp
      usbDevices = $usbDevicesResult.Output
      usbPorts = ($usbPortsResult.Output -split '\r?\n' | Where-Object { $_.Trim() }) -join ", "
      tetheringState = $tetheringState
      tetheringError = $tetheringError
      tetheringHint = $tetheringHint
      tethering = $tetheringResult.Output
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

if ($Action -eq "usb-tether-reset") {
  $resetResult = Invoke-SshCommand -Command $routerCommand
  if ($resetResult.ExitCode -ne 0) {
    Write-Result -Success:$false -Message "USB tether reset failed." -Extra @{
      host = $routerHost
      exitCode = $resetResult.ExitCode
      detail = $resetResult.Output
      requiresConfiguration = $true
    }
    exit 1
  }

  $beforePublicIp = ""
  $afterPublicIp = ""
  $tetheringJson = $null
  foreach ($line in ($resetResult.Output -split '\r?\n')) {
    if ($line -like "BEFORE_PUBLIC_IP=*") {
      $beforePublicIp = ($line -replace '^BEFORE_PUBLIC_IP=', '').Trim()
    } elseif ($line -like "AFTER_PUBLIC_IP=*") {
      $afterPublicIp = ($line -replace '^AFTER_PUBLIC_IP=', '').Trim()
    } elseif ($line.Trim().StartsWith("{")) {
      try {
        $tetheringJson = $line | ConvertFrom-Json -ErrorAction Stop
      } catch {
        $tetheringJson = $null
      }
    }
  }

  $tetheringState = if ($tetheringJson -and $tetheringJson.up) { "connected" } elseif ($tetheringJson) { "disconnected" } else { "" }
  $tetheringDevice = if ($tetheringJson) {
    if ($tetheringJson.l3_device) { [string]$tetheringJson.l3_device } elseif ($tetheringJson.device) { [string]$tetheringJson.device } else { "" }
  } else {
    ""
  }

  Write-Result -Success:$true -Message "USB tether reset completed." -Extra @{
    host = $routerHost
    detail = $resetResult.Output
    beforePublicIp = $beforePublicIp
    afterPublicIp = $afterPublicIp
    publicIpChanged = [bool]($beforePublicIp -and $afterPublicIp -and $beforePublicIp -ne $afterPublicIp)
    telemetry = @{
      mode = ""
      tetheringState = $tetheringState
      tetheringDevice = $tetheringDevice
      publicIp = $afterPublicIp
      previousPublicIp = $beforePublicIp
      uplinkMode = if ($afterPublicIp) { "router-uplink" } else { "" }
      uplinkInterface = $tetheringDevice
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
