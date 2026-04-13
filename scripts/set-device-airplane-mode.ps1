param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,
  [Parameter(Mandatory = $true)]
  [ValidateSet("on", "off")]
  [string]$Mode,
  [string]$SettingsPath = "",
  [string]$ActivityLogPath = ""
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
if (-not $SettingsPath) {
  $SettingsPath = Join-Path $root "config\\settings.json"
}
if (-not $ActivityLogPath) {
  $ActivityLogPath = Join-Path $root "logs\\activity.log"
}
$deviceLogPath = Join-Path $root ("logs\\airplane-" + $Serial + ".log")

function Write-AirplaneLog {
  param(
    [string]$Category,
    [string]$Message
  )

  $timestamp = (Get-Date).ToString("o")
  $line = "[$timestamp] [$Category] [$Serial] $Message"
  Add-Content -Path $ActivityLogPath -Value $line
  Add-Content -Path $deviceLogPath -Value $line
}

function Get-Settings {
  if (Test-Path $SettingsPath) {
    return Get-Content -Raw -Path $SettingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{ adbPath = "adb" }
}

function Invoke-Adb {
  param(
    [string[]]$Arguments,
    [switch]$IgnoreErrors
  )

  try {
    $output = & $script:AdbPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  catch {
    if (-not $IgnoreErrors) {
      throw
    }
    $output = $_.Exception.Message
    $exitCode = 1
  }

  if (-not $IgnoreErrors -and $exitCode -ne 0) {
    throw "adb $($Arguments -join ' ') failed with exit code $exitCode. Output: $output"
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = ($output | Out-String).Trim()
  }
}

function Invoke-MacroDroidHelper {
  param(
    [string[]]$ExtraArguments
  )

  $arguments = @(
    "-s", $Serial,
    "shell", "am", "broadcast",
    "-a", "com.arlosoft.macrodroid.helper.COMMAND",
    "-n", "com.arlosoft.macrodroid.helper/.CommandReceiver"
  ) + $ExtraArguments

  $result = Invoke-Adb -Arguments $arguments -IgnoreErrors
  Write-AirplaneLog -Category "airplane" -Message ("MacroDroid Helper command => exit " + $result.ExitCode + " output=" + $result.Output)
  return $result
}

function Set-AirplaneMode {
  $enabled = $Mode -eq "on"
  $target = if ($enabled) { "1" } else { "0" }
  $stateWord = if ($enabled) { "true" } else { "false" }
  $action = if ($enabled) { "enable" } else { "disable" }
  Write-AirplaneLog -Category "airplane" -Message ("Attempting to " + $action + " airplane mode")

  $helperResult = Invoke-MacroDroidHelper -ExtraArguments @(
    "--es", "command_type", "set_system_setting",
    "--es", "setting_type", "global",
    "--es", "setting_key", "airplane_mode_on",
    "--es", "setting_value_type", "int",
    "--es", "setting_value", $target,
    "--es", "macro_name", "PhoneFarm Airplane"
  )
  if ($helperResult.ExitCode -eq 0) {
    Write-AirplaneLog -Category "airplane" -Message "MacroDroid Helper accepted airplane mode request"
  }

  $attempts = @(
    @("shell", "settings", "put", "global", "airplane_mode_on", $target),
    @("shell", "cmd", "connectivity", "airplane-mode", $action),
    @("shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", $stateWord)
  )

  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
    Write-AirplaneLog -Category "airplane" -Message ("Command attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode + " output=" + $result.Output)
  }

  Start-Sleep -Seconds 3
  $verify = Invoke-Adb -Arguments @("-s", $Serial, "shell", "settings", "get", "global", "airplane_mode_on") -IgnoreErrors
  Write-AirplaneLog -Category "airplane" -Message ("Verify airplane_mode_on => exit " + $verify.ExitCode + " output=" + $verify.Output)
  if ($verify.Output.Trim() -ne $target) {
    throw "Unable to verify requested airplane mode setting."
  }
}

try {
  $settings = Get-Settings
  $script:AdbPath = if ($settings.adbPath) { $settings.adbPath } else { "adb" }
  Set-AirplaneMode
  exit 0
}
catch {
  Write-AirplaneLog -Category "airplane" -Message ("Airplane mode change failed: " + $_.Exception.Message)
  exit 1
}
