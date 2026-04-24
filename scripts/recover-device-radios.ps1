param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,
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
$deviceLogPath = Join-Path $root ("logs\\recover-" + $Serial + ".log")
$devicesPath = Join-Path $root "config\\devices.json"

function Write-RecoverLog {
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

function Get-DeviceConfig {
  if (Test-Path $devicesPath) {
    $config = Get-Content -Raw -Path $devicesPath | ConvertFrom-Json
    $device = $config.devices | Where-Object { $_.serial -eq $Serial } | Select-Object -First 1
    if ($device) {
      return $device
    }
  }

  return [pscustomobject]@{
    serial = $Serial
    role = "sim-direct"
  }
}

function Get-NormalizedRole {
  param([string]$Role)

  if ([string]::IsNullOrWhiteSpace($Role)) {
    $normalized = "sim-direct"
  } else {
    $normalized = $Role.Trim().ToLowerInvariant()
  }
  switch ($normalized) {
    "router-client" { return "router-linkpro" }
    "opal-client" { return "router-linkpro" }
    "router-linkpro" { return "router-linkpro" }
    "linkpro-routed" { return "router-linkpro" }
    default { return $normalized }
  }
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
  Write-RecoverLog -Category "recover" -Message ("MacroDroid Helper command => exit " + $result.ExitCode + " output=" + $result.Output)
  return $result
}

function Wait-ForDeviceOnline {
  param([int]$TimeoutSeconds = 60)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $result = Invoke-Adb -Arguments @("-s", $Serial, "get-state") -IgnoreErrors
    if (($result.Output | Out-String).Trim() -eq "device") {
      return
    }
    Start-Sleep -Seconds 3
  }
  throw "Device did not return online within $TimeoutSeconds seconds."
}

function Set-AirplaneModeOff {
  Write-RecoverLog -Category "recover" -Message "Attempting to force airplane mode off"
  
  # Try MacroDroid Helper first as it is more reliable for system settings
  $helperResult = Invoke-MacroDroidHelper -ExtraArguments @(
    "--es", "command_type", "set_system_setting",
    "--es", "setting_type", "global",
    "--es", "setting_key", "airplane_mode_on",
    "--es", "setting_value_type", "int",
    "--es", "setting_value", "0",
    "--es", "macro_name", "PhoneFarm Recover"
  )
  
  # Also try direct ADB settings and broadcasts
  $attempts = @(
    @("shell", "settings", "put", "global", "airplane_mode_on", "0"),
    @("shell", "cmd", "connectivity", "airplane-mode", "disable"),
    @("shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", "false")
  )

  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
    Write-RecoverLog -Category "recover" -Message ("Airplane mode clear attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode + " output=" + $result.Output)
  }

  Start-Sleep -Seconds 3
  $verify = Invoke-Adb -Arguments @("-s", $Serial, "shell", "settings", "get", "global", "airplane_mode_on") -IgnoreErrors
  Write-RecoverLog -Category "recover" -Message ("Airplane mode verify => exit " + $verify.ExitCode + " output=" + $verify.Output)
  return ($verify.Output -eq "0")
}

function Ensure-MobileDataEnabled {
  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "svc", "data", "enable") -IgnoreErrors
  Write-RecoverLog -Category "recover" -Message ("Mobile data enable => exit " + $result.ExitCode + " output=" + $result.Output)
}

function Ensure-WifiEnabled {
  Write-RecoverLog -Category "recover" -Message "Attempting to enable Wi-Fi"
  
  # Try MacroDroid Helper first
  $helperResult = Invoke-MacroDroidHelper -ExtraArguments @(
    "--es", "command_type", "set_wifi",
    "--ei", "wifi_state", "1",
    "--es", "macro_name", "PhoneFarm Recover"
  )
  
  # Standard ADB methods
  $attempts = @(
    @("shell", "svc", "wifi", "enable"),
    @("shell", "cmd", "wifi", "set-wifi-enabled", "enabled")
  )

  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
    Write-RecoverLog -Category "recover" -Message ("Wi-Fi enable attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode + " output=" + $result.Output)
  }
}

try {
  $settings = Get-Settings
  $deviceConfig = Get-DeviceConfig
  $script:AdbPath = if ($settings.adbPath) { $settings.adbPath } else { "adb" }

  Write-RecoverLog -Category "recover" -Message "Radio recovery started"
  Wait-ForDeviceOnline
  
  $airplaneCleared = Set-AirplaneModeOff
  Ensure-MobileDataEnabled
  
  $normalizedRole = Get-NormalizedRole $deviceConfig.role
  $wifiAttempted = $false
  if ($normalizedRole -eq "hotspot-client" -or $normalizedRole -eq "router-linkpro") {
    Ensure-WifiEnabled
    $wifiAttempted = $true
    Write-RecoverLog -Category "recover" -Message "Wi-Fi-routed role detected; Wi-Fi recovery attempted"
  }
  
  Write-RecoverLog -Category "recover" -Message "Radio recovery completed"
  
  $finalResult = @{
    ok = $true
    serial = $Serial
    airplaneModeOff = $airplaneCleared
    wifiAttempted = $wifiAttempted
    timestamp = (Get-Date).ToString("o")
  }
  Write-Output ($finalResult | ConvertTo-Json -Compress)
  exit 0
}
catch {
  $errorMessage = $_.Exception.Message
  Write-RecoverLog -Category "recover" -Message ("Radio recovery failed: " + $errorMessage)
  
  $finalResult = @{
    ok = $false
    serial = $Serial
    error = $errorMessage
    timestamp = (Get-Date).ToString("o")
  }
  Write-Output ($finalResult | ConvertTo-Json -Compress)
  exit 1
}
