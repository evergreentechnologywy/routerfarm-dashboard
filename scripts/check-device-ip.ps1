param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,
  [string]$SettingsPath = ""
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
if (-not $SettingsPath) {
  $SettingsPath = Join-Path $root "config\settings.json"
}

function Get-Settings {
  if (Test-Path $SettingsPath) {
    return Get-Content -Raw -Path $SettingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{ adbPath = "adb" }
}

function Resolve-AdbPath {
  param([string]$ConfiguredPath)

  if ($ConfiguredPath -and (Test-Path $ConfiguredPath)) {
    return $ConfiguredPath
  }

  $adbCommand = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($adbCommand -and $adbCommand.Source) {
    return $adbCommand.Source
  }

  return "adb"
}

function Invoke-Adb {
  param([string[]]$Arguments)

  $quotedArguments = foreach ($argument in $Arguments) {
    if ($null -eq $argument) {
      '""'
    } elseif ($argument -match '[\s"]') {
      '"' + ($argument -replace '"', '\"') + '"'
    } else {
      $argument
    }
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $process.StartInfo.FileName = $script:AdbPath
  $process.StartInfo.Arguments = ($quotedArguments -join ' ')
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.CreateNoWindow = $true
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $output = @($stdout, $stderr) -join [Environment]::NewLine
  [pscustomobject]@{
    ExitCode = $process.ExitCode
    Output = ($output | Out-String).Trim()
  }
}

function Get-DeviceState {
  param([string]$Serial)
  $result = Invoke-Adb -Arguments @("-s", $Serial, "get-state")
  $state = ($result.Output | Select-Object -First 1).Trim().ToLowerInvariant()
  [pscustomobject]@{
    ExitCode = $result.ExitCode
    State = $state
    Output = $result.Output
  }
}

function Get-NetworkReadiness {
  param([string]$Serial)

  $simState = Invoke-Adb -Arguments @("-s", $Serial, "shell", "getprop", "gsm.sim.state")
  $route = Invoke-Adb -Arguments @("-s", $Serial, "shell", "ip", "route")
  $ping = Invoke-Adb -Arguments @("-s", $Serial, "shell", "ping", "-c", "1", "1.1.1.1")

  $simText = ($simState.Output | Out-String).Trim()
  $routeText = ($route.Output | Out-String).Trim()
  $pingText = ($ping.Output | Out-String).Trim()

  $hasRoute = $routeText -match '(^|\s)default(\s|$)'
  $simAbsent = $simText -match 'ABSENT'
  $networkReachable = $ping.ExitCode -eq 0

  [pscustomobject]@{
    SimState = $simText
    Route = $routeText
    Ping = $pingText
    HasRoute = $hasRoute
    SimAbsent = $simAbsent
    NetworkReachable = $networkReachable
  }
}

function Get-FriendlyFailure {
  param(
    [string]$RawError,
    [string]$DeviceState
  )

  $message = ($RawError | Out-String).Trim()
  if (-not $message) {
    return "No device-side IP method succeeded."
  }

  if ($DeviceState -eq "offline" -or $message -match "\bdevice offline\b") {
    return "Device is offline in ADB. Reconnect or re-authorize the phone, then retry."
  }

  if ($DeviceState -eq "unauthorized" -or $message -match "\bunauthorized\b") {
    return "Device is not authorized for ADB. Accept the USB debugging prompt, then retry."
  }

  if ($message -match "Couldn't resolve host|Temporary failure in name resolution|Name or service not known") {
    return "Phone network is up but DNS resolution failed during the public IP check."
  }

  if ($message -match "Failed to connect|Connection timed out|Network is unreachable|No route to host") {
    return "Phone could not reach the public IP service from its own network path."
  }

  if ($message -match "not found|inaccessible or not found") {
    return "This Android build does not expose the required shell HTTP client for device-side public IP checks."
  }

  return $message
}

function Get-PublicIpFromBrowser {
  param([string]$Serial)

  $browserAttempts = @(
    @{ source = "device-browser-cloudflare-trace-1.1.1.1"; targetUrl = "http://1.1.1.1/cdn-cgi/trace" },
    @{ source = "device-browser-cloudflare-trace-1.0.0.1"; targetUrl = "http://1.0.0.1/cdn-cgi/trace" },
    @{ source = "device-browser-ipify"; targetUrl = "https://api64.ipify.org?format=text" },
    @{ source = "device-browser-icanhazip"; targetUrl = "https://icanhazip.com" },
    @{ source = "device-browser-ipinfo"; targetUrl = "https://ipinfo.io/ip" }
  )

  foreach ($attempt in $browserAttempts) {
    $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>RouterFarm Browser IP Check</title>
</head>
<body style="font-family:sans-serif;padding:24px;font-size:28px;">
  <div id="status">Checking...</div>
  <script>
    fetch('$($attempt.targetUrl)', { cache: 'no-store' })
      .then(function (response) { return response.text(); })
      .then(function (text) {
        document.title = text.trim();
        document.getElementById('status').innerText = text.trim();
      })
      .catch(function (error) {
        document.title = 'ERROR ' + error;
        document.getElementById('status').innerText = 'ERROR ' + error;
      });
  </script>
</body>
</html>
"@
    $dataUrl = "data:text/html," + [System.Uri]::EscapeDataString($html)

    $null = Invoke-Adb -Arguments @("-s", $Serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", $dataUrl)
    Start-Sleep -Seconds 7

    $dump = Invoke-Adb -Arguments @("-s", $Serial, "shell", "uiautomator", "dump", "/sdcard/routerfarm-window.xml")
    if ($dump.ExitCode -ne 0) {
      continue
    }

    $xml = Invoke-Adb -Arguments @("-s", $Serial, "shell", "cat", "/sdcard/routerfarm-window.xml")
    if ($xml.ExitCode -ne 0) {
      continue
    }

    $ip = Parse-PublicIp -Text $xml.Output
    if ($ip) {
      return [pscustomobject]@{
        success = $true
        ip = $ip
        source = $attempt.source
        error = ""
      }
    }
  }

  return [pscustomobject]@{
    success = $false
    ip = ""
    source = ""
    error = "Phone-side browser fallback did not return a detectable public IP."
  }
}

function Parse-PublicIp {
  param([string]$Text)
  $traceIp = [regex]::Match($Text, '(?im)^ip=(\d{1,3}(?:\.\d{1,3}){3})$')
  if ($traceIp.Success) { return $traceIp.Groups[1].Value }
  $jsonIp = [regex]::Match($Text, '(?im)"ip"\s*:\s*"([^"]+)"')
  if ($jsonIp.Success) { return $jsonIp.Groups[1].Value.Trim() }
  $ipv4 = [regex]::Match($Text, '\b\d{1,3}(?:\.\d{1,3}){3}\b')
  if ($ipv4.Success) { return $ipv4.Value }
  $ipv6 = [regex]::Match($Text, '\b(?:[a-fA-F0-9]{1,4}:){2,}[a-fA-F0-9]{1,4}\b')
  if ($ipv6.Success) { return $ipv6.Value }
  return ""
}

function Get-PublicIpFromHelper {
  param([string]$Serial)

  $packageName = "com.phonefarm.iphelper"
  $componentName = "com.phonefarm.iphelper/.MainActivity"

  $packageResult = Invoke-Adb -Arguments @("-s", $Serial, "shell", "pm", "path", $packageName)
  if ($packageResult.ExitCode -ne 0 -or $packageResult.Output -notmatch "package:") {
    return [pscustomobject]@{
      success = $false
      ip = ""
      source = ""
      error = "RouterFarm IP Helper is not installed on this device."
      missingHelper = $true
    }
  }

  $requestId = [guid]::NewGuid().ToString("N")
  $null = Invoke-Adb -Arguments @("-s", $Serial, "shell", "run-as", $packageName, "rm", "-f", "files/ip-check-result.json")
  $startResult = Invoke-Adb -Arguments @("-s", $Serial, "shell", "am", "start", "-n", $componentName, "--es", "requestId", $requestId)
  if ($startResult.ExitCode -ne 0) {
    return [pscustomobject]@{
      success = $false
      ip = ""
      source = ""
      error = "RouterFarm IP Helper could not be launched on the phone."
      missingHelper = $false
    }
  }

  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    Start-Sleep -Seconds 2
    $readResult = Invoke-Adb -Arguments @("-s", $Serial, "shell", "run-as", $packageName, "cat", "files/ip-check-result.json")
    if ($readResult.ExitCode -ne 0 -or -not $readResult.Output) {
      continue
    }

    try {
      $json = $readResult.Output | ConvertFrom-Json
    } catch {
      continue
    }

    if ($json.requestId -ne $requestId) {
      continue
    }

    if ($json.success -and $json.ip) {
      return [pscustomobject]@{
        success = $true
        ip = [string]$json.ip
        source = "routerfarm-ip-helper:$($json.source)"
        error = ""
        missingHelper = $false
      }
    }

    return [pscustomobject]@{
      success = $false
      ip = ""
      source = "routerfarm-ip-helper"
      error = [string]$json.error
      missingHelper = $false
    }
  }

  return [pscustomobject]@{
    success = $false
    ip = ""
    source = "routerfarm-ip-helper"
    error = "RouterFarm IP Helper timed out waiting for a result."
    missingHelper = $false
  }
}

$settings = Get-Settings
$script:AdbPath = Resolve-AdbPath -ConfiguredPath $settings.adbPath
$deviceState = Get-DeviceState -Serial $Serial
if ($deviceState.ExitCode -ne 0 -or $deviceState.State -eq "offline" -or $deviceState.State -eq "unauthorized") {
  [pscustomobject]@{
    success = $false
    ip = ""
    source = ""
    error = Get-FriendlyFailure -RawError $deviceState.Output -DeviceState $deviceState.State
  } | ConvertTo-Json -Compress
  exit 1
}

$networkReadiness = Get-NetworkReadiness -Serial $Serial
if (-not $networkReadiness.HasRoute -and -not $networkReadiness.NetworkReachable) {
  $reason = if ($networkReadiness.SimAbsent) {
    "No SIM card is present and the phone has no usable network route."
  } elseif ($networkReadiness.SimState) {
    "Phone has no usable network route. SIM state: $($networkReadiness.SimState)."
  } else {
    "Phone has no usable network route."
  }

  [pscustomobject]@{
    success = $false
    ip = ""
    source = ""
    error = $reason
  } | ConvertTo-Json -Compress
  exit 1
}

$helperResult = Get-PublicIpFromHelper -Serial $Serial
if ($helperResult.success) {
  $helperResult | ConvertTo-Json -Compress
  exit 0
}

$failure = ""
if (-not $helperResult.missingHelper) {
  $failure = if ($helperResult.error) {
    [string]$helperResult.error
  } else {
    "RouterFarm IP Helper failed to return a public IP."
  }
}

$attempts = @(
  @{ source = "device-curl-cloudflare-trace-1.1.1.1"; args = @("-s", $Serial, "shell", "curl", "-fsSL", "http://1.1.1.1/cdn-cgi/trace") },
  @{ source = "device-curl-cloudflare-trace-1.0.0.1"; args = @("-s", $Serial, "shell", "curl", "-fsSL", "http://1.0.0.1/cdn-cgi/trace") },
  @{ source = "device-toybox-wget-cloudflare-trace-1.1.1.1"; args = @("-s", $Serial, "shell", "toybox", "wget", "-qO-", "http://1.1.1.1/cdn-cgi/trace") },
  @{ source = "device-toybox-wget-cloudflare-trace-1.0.0.1"; args = @("-s", $Serial, "shell", "toybox", "wget", "-qO-", "http://1.0.0.1/cdn-cgi/trace") },
  @{ source = "device-curl-ipify"; args = @("-s", $Serial, "shell", "curl", "-fsSL", "https://api64.ipify.org?format=text") },
  @{ source = "device-curl-ifconfigme"; args = @("-s", $Serial, "shell", "curl", "-fsSL", "https://ifconfig.me/ip") },
  @{ source = "device-curl-ipinfo"; args = @("-s", $Serial, "shell", "curl", "-fsSL", "https://ipinfo.io/ip") },
  @{ source = "device-curl-icanhazip"; args = @("-s", $Serial, "shell", "curl", "-fsSL", "https://icanhazip.com") },
  @{ source = "device-toybox-wget-ipify"; args = @("-s", $Serial, "shell", "toybox", "wget", "-qO-", "https://api64.ipify.org?format=text") },
  @{ source = "device-wget-ifconfigme"; args = @("-s", $Serial, "shell", "wget", "-qO-", "https://ifconfig.me/ip") },
  @{ source = "device-toybox-wget-ipinfo"; args = @("-s", $Serial, "shell", "toybox", "wget", "-qO-", "https://ipinfo.io/ip") },
  @{ source = "device-toybox-wget-icanhazip"; args = @("-s", $Serial, "shell", "toybox", "wget", "-qO-", "https://icanhazip.com") }
)

for ($round = 1; $round -le 2; $round++) {
  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments $attempt.args
    if ($result.ExitCode -ne 0) {
      $failure = Get-FriendlyFailure -RawError $result.Output -DeviceState $deviceState.State
      continue
    }

    $ip = Parse-PublicIp -Text $result.Output
    if ($ip) {
      [pscustomobject]@{
        success = $true
        ip = $ip
        source = $attempt.source
        error = ""
      } | ConvertTo-Json -Compress
      exit 0
    }

    $failure = "Phone reached the check endpoint but no public IP address was detected in the response."
  }

  if ($round -lt 2) {
    Start-Sleep -Seconds 4
    $deviceState = Get-DeviceState -Serial $Serial
    if ($deviceState.State -eq "offline" -or $deviceState.State -eq "unauthorized") {
      $failure = Get-FriendlyFailure -RawError $deviceState.Output -DeviceState $deviceState.State
      break
    }
  }
}

$browserResult = Get-PublicIpFromBrowser -Serial $Serial
if ($browserResult.success) {
  $browserResult | ConvertTo-Json -Compress
  exit 0
}

if ($browserResult.error) {
  $failure = $browserResult.error
}

[pscustomobject]@{
  success = $false
  ip = ""
  source = ""
  error = if ($failure) { $failure } else { "No device-side IP method succeeded." }
} | ConvertTo-Json -Compress
exit 1
