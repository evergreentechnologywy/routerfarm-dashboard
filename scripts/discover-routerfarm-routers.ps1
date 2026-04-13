param(
  [string]$SubnetPrefix = "192.168.8",
  [int]$StartHost = 1,
  [int]$EndHost = 254,
  [string]$RoutersPath = "C:\RouterFarm\config\routers.json",
  [switch]$UseArpCache,
  [switch]$WriteConfig,
  [switch]$DisableUndiscovered
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Test-TcpPort {
  param(
    [string]$TargetHost,
    [int]$Port,
    [int]$TimeoutMs = 400
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
    $connected = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false) -and $client.Connected
    if ($client.Connected) {
      $client.EndConnect($iar)
    }
    return [bool]$connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Invoke-SshBoardProbe {
  param([string]$TargetHost)

  $sshArgs = @(
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=3",
    "-o", "HostKeyAlgorithms=+ssh-rsa",
    "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
    "root@$TargetHost",
    "ubus call system board"
  )

  try {
    $output = & ssh @sshArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      return $null
    }
    return ($output | Out-String).Trim()
  } catch {
    return $null
  }
}

function Invoke-WebProbe {
  param([string]$TargetHost)

  foreach ($scheme in @("https", "http")) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri ("{0}://{1}" -f $scheme, $TargetHost) -TimeoutSec 3
      return [pscustomobject]@{
        Scheme = $scheme
        StatusCode = $response.StatusCode
        Title = [regex]::Match([string]$response.Content, "<title>(.*?)</title>", "IgnoreCase").Groups[1].Value
        Server = [string]$response.Headers["Server"]
      }
    } catch {
      continue
    }
  }
  return $null
}

if (-not (Test-Path -LiteralPath $RoutersPath)) {
  throw "Routers config not found: $RoutersPath"
}

$routersConfig = Get-Content -LiteralPath $RoutersPath -Raw | ConvertFrom-Json
$configuredRouters = @($routersConfig.routers)
$discovered = New-Object System.Collections.Generic.List[object]
$targetHosts = New-Object System.Collections.Generic.List[string]

if ($UseArpCache) {
  $arpHosts = @(
    arp -a | ForEach-Object {
      if ($_ -match "\b$([regex]::Escape($SubnetPrefix))\.(\d{1,3})\b") {
        $matches[0]
      }
    } | Where-Object { $_ } | Sort-Object -Unique
  )
  foreach ($arpHost in $arpHosts) {
    $targetHosts.Add($arpHost) | Out-Null
  }
} else {
  for ($i = $StartHost; $i -le $EndHost; $i += 1) {
    $targetHosts.Add("$SubnetPrefix.$i") | Out-Null
  }
}

foreach ($targetHost in $targetHosts) {
  $sshOpen = Test-TcpPort -TargetHost $targetHost -Port 22
  $httpOpen = $false
  $httpsOpen = $false

  if (-not $sshOpen) {
    $httpOpen = Test-TcpPort -TargetHost $targetHost -Port 80
    $httpsOpen = Test-TcpPort -TargetHost $targetHost -Port 443
    if (-not $httpOpen -and -not $httpsOpen) {
      continue
    }
  }

  $board = $null
  $model = ""
  $hostname = ""
  $webProbe = $null
  $evidence = @()

  if ($sshOpen) {
    $board = Invoke-SshBoardProbe -TargetHost $targetHost
    if ($board) {
      try {
        $boardJson = $board | ConvertFrom-Json -ErrorAction Stop
        $model = [string]$boardJson.model
        $hostname = [string]$boardJson.hostname
      } catch {
        $model = ""
      }
      $evidence += "ssh"
    }
  }

  if (-not $board) {
    $webProbe = Invoke-WebProbe -TargetHost $targetHost
    if ($webProbe) {
      $evidence += $webProbe.Scheme
    }
  }

  $looksLikeRouter = $false
  if ($model -match "GL-SFT1200|glinet|OpenWrt") {
    $looksLikeRouter = $true
  } elseif ($hostname -match "GL-SFT1200") {
    $looksLikeRouter = $true
  } elseif ($webProbe -and (($webProbe.Title -match "GL\\.iNet|OpenWrt|Router") -or ($webProbe.Server -match "nginx|uhttpd"))) {
    $looksLikeRouter = $true
  }

  if ($looksLikeRouter) {
    $discovered.Add([pscustomobject]@{
      host = $targetHost
      sshOpen = [bool]$sshOpen
      httpOpen = [bool]$httpOpen
      httpsOpen = [bool]$httpsOpen
      hostname = $hostname
      model = $model
      title = if ($webProbe) { $webProbe.Title } else { "" }
      evidence = ($evidence -join ",")
    }) | Out-Null
  }
}

$ordered = @($discovered | Sort-Object { [version]$_.host })

if ($WriteConfig) {
  for ($idx = 0; $idx -lt $configuredRouters.Count; $idx += 1) {
    $router = $configuredRouters[$idx]
    if ($idx -lt $ordered.Count) {
      $router.host = $ordered[$idx].host
      $router.enabled = $true
    } elseif ($DisableUndiscovered) {
      $router.enabled = $false
    }
  }
  $routersConfig.routers = $configuredRouters
  ($routersConfig | ConvertTo-Json -Depth 8) + "`n" | Set-Content -LiteralPath $RoutersPath -Encoding UTF8
}

[pscustomobject]@{
  ok = $true
  subnet = "$SubnetPrefix.0/24"
  discoveredCount = $ordered.Count
  writeConfig = [bool]$WriteConfig
  disableUndiscovered = [bool]$DisableUndiscovered
  routers = $ordered
} | ConvertTo-Json -Depth 8
