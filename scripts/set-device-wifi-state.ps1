param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,

  [Parameter(Mandatory = $true)]
  [ValidateSet("enable", "disable")]
  [string]$State,

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
    state = $State
    message = $Message
    checkedAt = [DateTime]::UtcNow.ToString("o")
  }

  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }

  $payload | ConvertTo-Json -Compress
}

function Invoke-Adb {
  param([string[]]$Arguments)

  try {
    $output = & $script:AdbPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } catch {
    $output = $_.Exception.Message
    $exitCode = 1
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = [string]($output | Out-String).Trim()
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

$settings = if (Test-Path -LiteralPath $SettingsPath) {
  Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
} else {
  $null
}
$script:AdbPath = if ($settings -and $settings.adbPath) { [string]$settings.adbPath } else { "adb" }

$targetWifiState = if ($State -eq "enable") { "1" } else { "0" }
$helperResult = Invoke-MacroDroidHelper -ExtraArguments @(
  "--es", "command_type", "set_wifi",
  "--ei", "wifi_state", $targetWifiState,
  "--es", "macro_name", "RouterFarm Wi-Fi State"
)

$commandAttempts = @(
  @("shell", "svc", "wifi", $State),
  @("shell", "cmd", "wifi", "set-wifi-enabled", $(if ($State -eq "enable") { "enabled" } else { "disabled" }))
)
$successfulCommands = @()
$failedCommands = @()

foreach ($attempt in $commandAttempts) {
  $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt)
  if ($result.ExitCode -eq 0) {
    $successfulCommands += ,([string]($attempt -join " "))
  } else {
    $failedCommands += ,([string](($attempt -join " ") + " => " + $result.Output))
  }
}

Start-Sleep -Seconds 2
$verifiedState = Get-WifiEnabledState
$expectedEnabled = ($State -eq "enable")

if ($verifiedState -eq $expectedEnabled) {
  Write-Result -Success:$true -Message "Wi-Fi $State verified." -Extra @{
    helperAccepted = ($helperResult.ExitCode -eq 0)
    successfulCommands = $successfulCommands
    failedCommands = $failedCommands
  }
  exit 0
}

if ($null -eq $verifiedState -and ($helperResult.ExitCode -eq 0 -or $successfulCommands.Count -gt 0)) {
  Write-Result -Success:$true -Message "Wi-Fi $State requested." -Extra @{
    helperAccepted = ($helperResult.ExitCode -eq 0)
    successfulCommands = $successfulCommands
    failedCommands = $failedCommands
  }
  exit 0
}

$failureParts = @()
if ($helperResult.ExitCode -ne 0 -and $helperResult.Output) {
  $failureParts += "MacroDroid Helper: $($helperResult.Output)"
}
if ($failedCommands.Count -gt 0) {
  $failureParts += $failedCommands
}
if ($verifiedState -ne $null) {
  $failureParts += "Verified Wi-Fi state was " + $(if ($verifiedState) { "enabled" } else { "disabled" })
}
if ($failureParts.Count -eq 0) {
  $failureParts += "No Wi-Fi control path succeeded."
}

Write-Result -Success:$false -Message ([string]($failureParts -join " | ")) -Extra @{
  helperAccepted = ($helperResult.ExitCode -eq 0)
  successfulCommands = $successfulCommands
  failedCommands = $failedCommands
}
exit 1
