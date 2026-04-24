param(
  [Parameter(Mandatory = $true)]
  [string]$RouterId,

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
    message = $Message
    checkedAt = [DateTime]::UtcNow.ToString("o")
  }
  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }
  $payload | ConvertTo-Json -Depth 8 -Compress
}

function Invoke-RemoteCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  if ($usePlink) {
    $plinkArgs = @(
      "-ssh",
      "-batch",
      "-pw", $routerPassword,
      "-hostkey", $routerHostKey,
      "-P", "$sshPort",
      "$username@$routerHost",
      $Command
    )

    try {
      $output = & $sshPath @plinkArgs 2>&1
      return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = [string]($output | Out-String).Trim()
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
    "-o", "ConnectTimeout=5",
    "-o", "HostKeyAlgorithms=+ssh-rsa",
    "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
    "-p", "$sshPort",
    "$username@$routerHost",
    $Command
  )

  try {
    $output = & $sshPath @sshArgs 2>&1
    return [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = [string]($output | Out-String).Trim()
    }
  } catch {
    return [pscustomobject]@{
      ExitCode = 1
      Output = $_.Exception.Message
    }
  }
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
  Write-Result -Success:$false -Message "Router host is not configured."
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

$result = Invoke-RemoteCommand -Command "uci -q get glconfig.general.mode; echo '---'; uci show glconfig.general"
if ($result.ExitCode -ne 0) {
  Write-Result -Success:$false -Message "SSH query failed." -Extra @{ host = $routerHost; detail = $result.Output }
  exit 1
}

$parts = $result.Output -split "---"
$mode = ($parts[0] -split '\r?\n' | Select-Object -First 1).Trim()
Write-Result -Success:$true -Message "Router mode query completed." -Extra @{
  host = $routerHost
  mode = $mode
  detail = $result.Output
}
exit 0
