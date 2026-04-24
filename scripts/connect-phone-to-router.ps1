param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,

  [Parameter(Mandatory = $true)]
  [string]$Ssid,

  [string]$Password = "",
  [string]$SettingsPath = "C:\RouterFarm\config\settings.json"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Write-Result {
  param(
    [bool]$Success,
    [string]$Message,
    [hashtable]$Extra = @{}
  )

  $payload = @{
    ok = $Success
    serial = $Serial
    ssid = $Ssid
    message = $Message
    checkedAt = [DateTime]::UtcNow.ToString("o")
    requiresManualAssist = $false
  }

  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }

  $payload | ConvertTo-Json -Depth 8 -Compress
}

function Get-Settings {
  if (Test-Path -LiteralPath $SettingsPath) {
    return Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
  }
  return [pscustomobject]@{ adbPath = "adb" }
}

function Invoke-Adb {
  param(
    [string[]]$Arguments,
    [int]$TimeoutSeconds = 4
  )

  if ($script:OverallDeadline -and (Get-Date) -ge $script:OverallDeadline) {
    return [pscustomobject]@{
      ExitCode = 124
      Output = "ADB command skipped because the router Wi-Fi join deadline was exceeded."
    }
  }

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
  $process.StartInfo.Arguments = ($quotedArguments -join " ")
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.CreateNoWindow = $true

  try {
    [void]$process.Start()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        $process.Kill()
      } catch {
        # Ignore kill errors after timeout.
      }
      return [pscustomobject]@{
        ExitCode = 124
        Output = "ADB command timed out after $TimeoutSeconds seconds."
      }
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $output = @($stdout, $stderr) -join [Environment]::NewLine
    $exitCode = $process.ExitCode
  } catch {
    $output = $_.Exception.Message
    $exitCode = 1
  } finally {
    $process.Dispose()
  }

  [pscustomobject]@{
    ExitCode = $exitCode
    Output = [string]($output | Out-String).Trim()
  }
}

function Get-ConnectedSsid {
  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "dumpsys", "wifi")
  if ($result.ExitCode -ne 0) {
    return ""
  }

  $patterns = @(
    'mWifiInfo.*SSID:\s*"([^"]+)"',
    'WifiInfo:.*SSID:\s*"([^"]+)"',
    'mWifiInfo.*SSID:\s*([^,\r\n]+)',
    'WifiInfo:.*SSID:\s*([^,\r\n]+)',
    'Current connected network:\s*"([^"]+)"',
    'curNetwork=.*?"([^"]+)"'
  )

  foreach ($pattern in $patterns) {
    $match = [regex]::Match($result.Output, $pattern)
    if ($match.Success) {
      $ssid = [string]$match.Groups[1].Value
      $ssid = $ssid.Trim().Trim('"')
      if ($ssid -and $ssid -ne "<unknown ssid>") {
        return $ssid
      }
    }
  }

  return ""
}

function Wait-ForWifiAssociation {
  param(
    [string]$TargetSsid,
    [int]$TimeoutSeconds = 15
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $connectedSsid = Get-ConnectedSsid
    if ($connectedSsid -eq $TargetSsid) {
      return $connectedSsid
    }
    Start-Sleep -Milliseconds 1500
  }

  return ""
}

function Open-WifiSettings {
  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "am", "start", "-a", "android.settings.WIFI_SETTINGS")
  if ($result.ExitCode -ne 0) {
    throw "Failed to open Wi-Fi settings: $($result.Output)"
  }
  Start-Sleep -Seconds 2
}

function Open-AddNetworkDialog {
  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "am", "start", "-n", "com.android.settings/.wifi.WifiDialogActivity")
  if ($result.ExitCode -ne 0) {
    throw "Failed to open Add network dialog: $($result.Output)"
  }
  Start-Sleep -Seconds 2
}

function Get-UiDumpXml {
  $dump = Invoke-Adb -Arguments @("-s", $Serial, "shell", "uiautomator", "dump", "/sdcard/routerfarm-window.xml")
  if ($dump.ExitCode -ne 0) {
    throw "uiautomator dump failed: $($dump.Output)"
  }

  $xmlResult = Invoke-Adb -Arguments @("-s", $Serial, "shell", "cat", "/sdcard/routerfarm-window.xml")
  if ($xmlResult.ExitCode -ne 0 -or -not $xmlResult.Output) {
    throw "Unable to read Wi-Fi settings UI dump."
  }

  return [xml]$xmlResult.Output
}

function Get-UiNodes {
  param([xml]$Document)

  if (-not $Document) {
    return @()
  }

  return @($Document.SelectNodes("//node"))
}

function Get-NodeAttribute {
  param(
    $Node,
    [string]$Name
  )

  if (-not $Node) {
    return ""
  }

  if ($Node.PSObject.Methods.Name -contains "GetAttribute") {
    return [string]$Node.GetAttribute($Name)
  }

  return [string]$Node.$Name
}

function Get-NodeText {
  param($Node)

  if (-not $Node) {
    return ""
  }

  $value = Get-NodeAttribute -Node $Node -Name "text"
  if (-not $value) {
    $value = [string]$Node.text
  }
  return $value
}

function Get-NormalizedUiText {
  param([string]$Text)

  $value = if ($null -eq $Text) { "" } else { [string]$Text }
  return $value.Trim().ToUpperInvariant()
}

function Get-NodeBoundsCenter {
  param($Node)

  $bounds = Get-NodeAttribute -Node $Node -Name "bounds"
  $match = [regex]::Match($bounds, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
  if (-not $match.Success) {
    return $null
  }

  $left = [int]$match.Groups[1].Value
  $top = [int]$match.Groups[2].Value
  $right = [int]$match.Groups[3].Value
  $bottom = [int]$match.Groups[4].Value

  return [pscustomobject]@{
    X = [int](($left + $right) / 2)
    Y = [int](($top + $bottom) / 2)
  }
}

function Invoke-Tap {
  param(
    [int]$X,
    [int]$Y
  )

  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "input", "tap", [string]$X, [string]$Y)
  if ($result.ExitCode -ne 0) {
    throw "Tap command failed: $($result.Output)"
  }
}

function Invoke-TapNode {
  param($Node)

  $point = Get-NodeBoundsCenter -Node $Node
  if (-not $point) {
    throw "UI node could not be tapped."
  }

  Invoke-Tap -X $point.X -Y $point.Y
}

function Invoke-Swipe {
  param(
    [int]$StartX,
    [int]$StartY,
    [int]$EndX,
    [int]$EndY,
    [int]$DurationMs = 250
  )

  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "input", "swipe", [string]$StartX, [string]$StartY, [string]$EndX, [string]$EndY, [string]$DurationMs)
  if ($result.ExitCode -ne 0) {
    throw "Swipe command failed: $($result.Output)"
  }
}

function Invoke-SwipeUp {
  Invoke-Swipe -StartX 360 -StartY 1100 -EndX 360 -EndY 300 -DurationMs 250
}

function Invoke-DialogScrollUp {
  Invoke-Swipe -StartX 630 -StartY 360 -EndX 630 -EndY 250 -DurationMs 250
}

function Invoke-InputText {
  param([string]$Text)

  $escaped = $Text -replace " ", "%s"
  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "input", "text", $escaped)
  if ($result.ExitCode -ne 0) {
    throw "Password entry failed: $($result.Output)"
  }
}

function Invoke-Keyevent {
  param(
    [string]$KeyCode
  )

  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "input", "keyevent", $KeyCode)
  if ($result.ExitCode -ne 0) {
    throw "Keyevent '$KeyCode' failed: $($result.Output)"
  }
}

function Invoke-MacroDroidHelper {
  param([string[]]$ExtraArguments)

  return Invoke-Adb -Arguments (@(
    "-s", $Serial,
    "shell", "am", "broadcast",
    "-a", "com.arlosoft.macrodroid.helper.COMMAND",
    "-n", "com.arlosoft.macrodroid.helper/.CommandReceiver"
  ) + $ExtraArguments)
}

function Get-WifiEnabledState {
  $settingsResult = Invoke-Adb -Arguments @("-s", $Serial, "shell", "settings", "get", "global", "wifi_on")
  if ($settingsResult.ExitCode -eq 0) {
    $value = $settingsResult.Output.Trim()
    if ($value -eq "1") {
      return $true
    }
    if ($value -eq "0") {
      return $false
    }
  }

  $dumpResult = Invoke-Adb -Arguments @("-s", $Serial, "shell", "dumpsys", "wifi")
  if ($dumpResult.ExitCode -eq 0) {
    if ($dumpResult.Output -match "Wi-?Fi is enabled|wifi is enabled|mWifiEnabled\s*=\s*true|WifiState.*enabled") {
      return $true
    }
    if ($dumpResult.Output -match "Wi-?Fi is disabled|wifi is disabled|mWifiEnabled\s*=\s*false|WifiState.*disabled") {
      return $false
    }
  }

  return $null
}

function Invoke-WifiStateScript {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("enable", "disable")]
    [string]$State
  )

  $wifiStateScriptPath = Join-Path $PSScriptRoot "set-device-wifi-state.ps1"
  if (-not (Test-Path -LiteralPath $wifiStateScriptPath)) {
    return $null
  }

  $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $wifiStateScriptPath -Serial $Serial -State $State -SettingsPath $SettingsPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "set-device-wifi-state.ps1 failed: $([string]($output | Out-String).Trim())"
  }

  $jsonLine = @($output | Where-Object { $_ -and $_.ToString().Trim() }) | Select-Object -Last 1
  if (-not $jsonLine) {
    throw "set-device-wifi-state.ps1 returned no result."
  }

  try {
    return ($jsonLine | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    throw "set-device-wifi-state.ps1 returned invalid JSON: $jsonLine"
  }
}

function Ensure-WifiEnabled {
  $wifiStateResult = Invoke-WifiStateScript -State "enable"
  if ($wifiStateResult -and $wifiStateResult.ok) {
    return [string]$wifiStateResult.message
  }

  $verifiedState = Get-WifiEnabledState
  if ($verifiedState -eq $true) {
    return "Wi-Fi verified enabled before pairing."
  }
  if ($verifiedState -eq $false) {
    throw "Wi-Fi stayed disabled after helper and ADB enable attempts."
  }

  throw "Unable to request Wi-Fi enable before pairing."
}

function Find-NodeByText {
  param(
    [Object[]]$Nodes,
    [string]$Text
  )

  foreach ($node in $Nodes) {
    if ((Get-NodeText -Node $node) -eq $Text) {
      return $node
    }
  }

  return $null
}

function Find-NodeByTextCandidates {
  param(
    [Object[]]$Nodes,
    [string[]]$Candidates
  )

  $candidateLookup = @{}
  foreach ($candidate in $Candidates) {
    $candidateLookup[(Get-NormalizedUiText -Text $candidate)] = $true
  }

  foreach ($node in $Nodes) {
    if ($candidateLookup.ContainsKey((Get-NormalizedUiText -Text (Get-NodeText -Node $node)))) {
      return $node
    }
  }

  return $null
}

function Find-NodeByTextRegex {
  param(
    [Object[]]$Nodes,
    [string]$Pattern
  )

  foreach ($node in $Nodes) {
    $text = Get-NodeText -Node $node
    if ($text -match $Pattern) {
      return $node
    }
  }

  return $null
}

function Find-NodeByResourceIdRegex {
  param(
    [Object[]]$Nodes,
    [string]$Pattern
  )

  foreach ($node in $Nodes) {
    $resourceId = Get-NodeAttribute -Node $node -Name "resource-id"
    if ($resourceId -match $Pattern) {
      return $node
    }
  }

  return $null
}

function Find-PasswordField {
  param([Object[]]$Nodes)

  $fallbackEditText = $null
  foreach ($node in $Nodes) {
    $className = Get-NodeAttribute -Node $node -Name "class"
    $resourceId = Get-NodeAttribute -Node $node -Name "resource-id"
    $text = Get-NodeText -Node $node
    $description = Get-NodeAttribute -Node $node -Name "content-desc"
    $signature = "$className $resourceId $text $description"
    if ($signature -match "password|Password|Contrase") {
      return $node
    }
    if (-not $fallbackEditText -and $className -match "EditText") {
      $fallbackEditText = $node
    }
  }

  return $fallbackEditText
}

function Find-ConnectButton {
  param([Object[]]$Nodes)

  return Find-NodeByTextCandidates -Nodes $Nodes -Candidates @(
    "Connect",
    "Join",
    "Save",
    "OK",
    "Conectar",
    "Guardar",
    "Aceptar",
    "CONECTAR",
    "GUARDAR",
    "ACEPTAR"
  )
}

function Try-ConnectViaVisibleSsid {
  param(
    [string]$TargetSsid,
    [string]$WifiPassword
  )

  Open-WifiSettings

  $targetNode = $null
  for ($scroll = 0; $scroll -lt 4 -and -not $targetNode; $scroll += 1) {
    $nodes = Get-UiNodes -Document (Get-UiDumpXml)
    $targetNode = Find-NodeByText -Nodes $nodes -Text $TargetSsid
    if (-not $targetNode -and $scroll -lt 3) {
      Invoke-SwipeUp
      Start-Sleep -Milliseconds 800
    }
  }

  if (-not $targetNode) {
    return [pscustomobject]@{
      success = $false
      notFound = $true
      connectedSsid = ""
      detail = "Target SSID '$TargetSsid' was not visible in Wi-Fi settings."
    }
  }

  Invoke-TapNode -Node $targetNode
  Start-Sleep -Seconds 1

  if (-not [string]::IsNullOrWhiteSpace($WifiPassword)) {
    $dialogNodes = Get-UiNodes -Document (Get-UiDumpXml)
    $passwordField = Find-PasswordField -Nodes $dialogNodes
    if ($passwordField) {
      Invoke-TapNode -Node $passwordField
      Start-Sleep -Milliseconds 400
      Invoke-InputText -Text $WifiPassword
      Start-Sleep -Milliseconds 400
    }

    $connectButton = Find-ConnectButton -Nodes $dialogNodes
    if ($connectButton) {
      Invoke-TapNode -Node $connectButton
    } else {
      Invoke-Keyevent -KeyCode "66"
    }
  }

  $connectedSsid = Wait-ForWifiAssociation -TargetSsid $TargetSsid -TimeoutSeconds 15
  if (-not $connectedSsid) {
    return [pscustomobject]@{
      success = $false
      notFound = $false
      connectedSsid = ""
      detail = "Phone did not associate to '$TargetSsid' after Wi-Fi settings automation."
    }
  }

  return [pscustomobject]@{
    success = $true
    notFound = $false
    connectedSsid = $connectedSsid
    detail = "Phone connected through Wi-Fi settings automation."
  }
}

function Connect-ViaAddNetworkDialog {
  param(
    [string]$TargetSsid,
    [string]$WifiPassword
  )

  try {
    Open-AddNetworkDialog
    $dialogNodes = Get-UiNodes -Document (Get-UiDumpXml)
    $ssidField = Find-NodeByResourceIdRegex -Nodes $dialogNodes -Pattern '(^|:)id/ssid$'
    if (-not $ssidField) {
      throw "Add network dialog did not expose an SSID field."
    }

    Invoke-TapNode -Node $ssidField
    Start-Sleep -Milliseconds 300
    Invoke-InputText -Text $TargetSsid
    Start-Sleep -Milliseconds 400
    Invoke-Keyevent -KeyCode "4"
    Start-Sleep -Milliseconds 400

    if (-not [string]::IsNullOrWhiteSpace($WifiPassword)) {
      $dialogNodes = Get-UiNodes -Document (Get-UiDumpXml)
      $securitySpinner = Find-NodeByResourceIdRegex -Nodes $dialogNodes -Pattern '(^|:)id/security$'
      if (-not $securitySpinner) {
        throw "Add network dialog did not expose a security selector."
      }

      Invoke-TapNode -Node $securitySpinner
      Start-Sleep -Milliseconds 700

      $securityNodes = Get-UiNodes -Document (Get-UiDumpXml)
      $securityChoice = Find-NodeByTextRegex -Nodes $securityNodes -Pattern 'WPA.*PSK'
      if (-not $securityChoice) {
        throw "Add network dialog did not expose a WPA/WPA2 PSK option."
      }

      Invoke-TapNode -Node $securityChoice
      Start-Sleep -Milliseconds 700

      $passwordField = $null
      for ($attempt = 0; $attempt -lt 2 -and -not $passwordField; $attempt += 1) {
        $dialogNodes = Get-UiNodes -Document (Get-UiDumpXml)
        $passwordField = Find-NodeByResourceIdRegex -Nodes $dialogNodes -Pattern '(^|:)id/password$'
        if (-not $passwordField -and $attempt -lt 1) {
          Invoke-DialogScrollUp
          Start-Sleep -Milliseconds 700
        }
      }

      if (-not $passwordField) {
        throw "Add network dialog did not expose a password field."
      }

      Invoke-TapNode -Node $passwordField
      Start-Sleep -Milliseconds 300
      Invoke-InputText -Text $WifiPassword
      Start-Sleep -Milliseconds 400
      Invoke-Keyevent -KeyCode "4"
      Start-Sleep -Milliseconds 400
    }

    $dialogNodes = Get-UiNodes -Document (Get-UiDumpXml)
    $saveButton = Find-NodeByResourceIdRegex -Nodes $dialogNodes -Pattern '^android:id/button1$'
    if (-not $saveButton) {
      $saveButton = Find-ConnectButton -Nodes $dialogNodes
    }
    if (-not $saveButton) {
      throw "Add network dialog did not expose a Save/Connect button."
    }

    Invoke-TapNode -Node $saveButton
  } catch {
    Open-AddNetworkDialog
    Invoke-Tap -X 446 -Y 203
    Start-Sleep -Milliseconds 300
    Invoke-InputText -Text $TargetSsid
    Start-Sleep -Milliseconds 400
    Invoke-Keyevent -KeyCode "4"
    Start-Sleep -Milliseconds 400

    if (-not [string]::IsNullOrWhiteSpace($WifiPassword)) {
      Invoke-Tap -X 443 -Y 314
      Start-Sleep -Milliseconds 700
      Invoke-Tap -X 407 -Y 418
      Start-Sleep -Milliseconds 700
      Invoke-DialogScrollUp
      Start-Sleep -Milliseconds 700
      Invoke-Tap -X 446 -Y 291
      Start-Sleep -Milliseconds 300
      Invoke-InputText -Text $WifiPassword
      Start-Sleep -Milliseconds 400
      Invoke-Keyevent -KeyCode "4"
      Start-Sleep -Milliseconds 400
    }

    Invoke-Tap -X 624 -Y 414
  }

  $connectedSsid = Wait-ForWifiAssociation -TargetSsid $TargetSsid -TimeoutSeconds 20
  if (-not $connectedSsid) {
    throw "Phone did not associate to '$TargetSsid' after Add network automation."
  }

  return $connectedSsid
}

function Try-DirectWifiConnect {
  param(
    [string]$TargetSsid,
    [string]$WifiPassword
  )

  $commands = @()
  if ([string]::IsNullOrWhiteSpace($WifiPassword)) {
    $commands += ,@("shell", "cmd", "wifi", "connect-network", "open", $TargetSsid)
    $commands += ,@("shell", "cmd", "-w", "wifi", "connect-network", "open", $TargetSsid)
  } else {
    $commands += ,@("shell", "cmd", "wifi", "connect-network", "wpa2", $TargetSsid, $WifiPassword)
    $commands += ,@("shell", "cmd", "-w", "wifi", "connect-network", "wpa2", $TargetSsid, $WifiPassword)
  }

  foreach ($command in $commands) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $command)
    if ($result.ExitCode -eq 0) {
      $connectedSsid = Wait-ForWifiAssociation -TargetSsid $TargetSsid -TimeoutSeconds 10
      if ($connectedSsid) {
        return [pscustomobject]@{
          success = $true
          connectedSsid = $connectedSsid
          detail = $result.Output
          blocked = $false
        }
      }
    }

    if ($result.Output -match "does not have access to wifi commands|Security exception") {
      return [pscustomobject]@{
        success = $false
        connectedSsid = ""
        detail = $result.Output
        blocked = $true
      }
    }
  }

  return [pscustomobject]@{
    success = $false
    connectedSsid = ""
    detail = "Direct Wi-Fi connect command was not accepted."
    blocked = $false
  }
}

$settings = Get-Settings
$script:AdbPath = if ($settings.adbPath) { [string]$settings.adbPath } else { "adb" }
$script:OverallDeadline = (Get-Date).AddSeconds(180)

$lastError = ""
$wifiEnableDetail = ""
for ($attempt = 1; $attempt -le 3; $attempt += 1) {
  try {
    $wifiEnableDetail = Ensure-WifiEnabled

    $alreadyConnected = Get-ConnectedSsid
    if ($alreadyConnected -eq $Ssid) {
      Write-Result -Success:$true -Message "Phone is already associated to the assigned router Wi-Fi." -Extra @{
        method = "already-connected"
        retryCount = $attempt
        connectedSsid = $alreadyConnected
        detail = $wifiEnableDetail
      }
      exit 0
    }

    $directResult = Try-DirectWifiConnect -TargetSsid $Ssid -WifiPassword $Password
    if ($directResult.success) {
      Write-Result -Success:$true -Message "Phone connected to the assigned router Wi-Fi." -Extra @{
        method = "adb-cmd"
        retryCount = $attempt
        connectedSsid = $directResult.connectedSsid
        detail = @($wifiEnableDetail, $directResult.detail) -join " | "
      }
      exit 0
    }

    try {
      $visibleResult = Try-ConnectViaVisibleSsid -TargetSsid $Ssid -WifiPassword $Password
    } catch {
      $visibleResult = [pscustomobject]@{
        success = $false
        notFound = $true
        connectedSsid = ""
        detail = "Visible Wi-Fi scan path failed: $($_.Exception.Message)"
      }
    }
    if ($visibleResult.success) {
      Write-Result -Success:$true -Message "Phone connected to the assigned router Wi-Fi through Wi-Fi settings automation." -Extra @{
        method = "ui-automation"
        retryCount = $attempt
        connectedSsid = $visibleResult.connectedSsid
        detail = @($wifiEnableDetail, $directResult.detail, $visibleResult.detail) -join " | "
      }
      exit 0
    }

    $connectedSsid = Connect-ViaAddNetworkDialog -TargetSsid $Ssid -WifiPassword $Password
    Write-Result -Success:$true -Message "Phone connected to the assigned router Wi-Fi through Add network automation." -Extra @{
      method = "add-network-ui"
      retryCount = $attempt
      connectedSsid = $connectedSsid
      detail = @($wifiEnableDetail, $directResult.detail, $visibleResult.detail) -join " | "
    }
    exit 0
  } catch {
    $lastError = $_.Exception.Message
    Start-Sleep -Seconds 1
  }
}

Write-Result -Success:$false -Message "Phone-side Wi-Fi connect failed after 3 attempts." -Extra @{
  retryCount = 3
  lastError = $lastError
}
exit 1
