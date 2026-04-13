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
$devicesPath = Join-Path $root "config\\devices.json"
if (-not $ActivityLogPath) {
  $ActivityLogPath = Join-Path $root "logs\\activity.log"
}
$deviceLogPath = Join-Path $root ("logs\\prep-" + $Serial + ".log")

function Write-PrepLog {
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
  return [pscustomobject]@{
    adbPath = "adb"
    prep = [pscustomobject]@{
      minWaitSeconds = 25
      maxWaitSeconds = 45
      onlineTimeoutSeconds = 90
    }
  }
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
    parentHotspotSerial = ""
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
  Write-PrepLog -Category "prep" -Message ("MacroDroid Helper command => exit " + $result.ExitCode + " output=" + $result.Output)
  return $result
}

function Wait-ForDeviceOnline {
  param([int]$TimeoutSeconds)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $result = Invoke-Adb -Arguments @("-s", $Serial, "get-state") -IgnoreErrors
    if ($result.ExitCode -eq 0 -and $result.Output.Trim() -eq "device") {
      return
    }
    Start-Sleep -Seconds 3
  }
  throw "Device did not return online within $TimeoutSeconds seconds."
}

function Wait-ForDeviceDisconnect {
  param([int]$TimeoutSeconds)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $result = Invoke-Adb -Arguments @("-s", $Serial, "get-state") -IgnoreErrors
    if ($result.ExitCode -ne 0 -or $result.Output.Trim() -ne "device") {
      return
    }
    Start-Sleep -Seconds 2
  }
  Write-PrepLog -Category "prep" -Message "Timed out waiting for device disconnect after reboot request; continuing to online wait"
}

function Set-AirplaneMode {
  param([bool]$Enabled)

  $target = if ($Enabled) { "1" } else { "0" }
  $stateWord = if ($Enabled) { "true" } else { "false" }
  $action = if ($Enabled) { "enable" } else { "disable" }
  Write-PrepLog -Category "prep" -Message "Attempting to $action airplane mode"

  $helperResult = Invoke-MacroDroidHelper -ExtraArguments @(
    "--es", "command_type", "set_system_setting",
    "--es", "setting_type", "global",
    "--es", "setting_key", "airplane_mode_on",
    "--es", "setting_value_type", "int",
    "--es", "setting_value", $target,
    "--es", "macro_name", "PhoneFarm Prep"
  )
  if ($helperResult.ExitCode -eq 0) {
    Write-PrepLog -Category "prep" -Message "MacroDroid Helper accepted airplane mode request"
  }

  $attempts = @(
    @("shell", "settings", "put", "global", "airplane_mode_on", $target),
    @("shell", "cmd", "connectivity", "airplane-mode", $action),
    @("shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", $stateWord)
  )

  foreach ($attempt in $attempts) {
    try {
      $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
      Write-PrepLog -Category "prep" -Message ("Airplane mode command attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode + " output=" + $result.Output)
    }
    catch {
      Write-PrepLog -Category "prep" -Message ("Airplane mode command attempt: adb " + ($attempt -join " ") + " => exception " + $_.Exception.Message)
    }
  }

  Start-Sleep -Seconds 3
  $verify = Invoke-Adb -Arguments @("-s", $Serial, "shell", "settings", "get", "global", "airplane_mode_on") -IgnoreErrors
  if ($verify.Output.Trim() -ne $target) {
    Write-PrepLog -Category "prep" -Message "Unable to verify airplane mode state through ADB settings; falling back to radio reset."
    return $false
  }

  return $true
}

function Ensure-AirplaneModeOff {
  Write-PrepLog -Category "prep" -Message "Preflight: ensuring airplane mode is off before prep"
  $current = Invoke-Adb -Arguments @("-s", $Serial, "shell", "settings", "get", "global", "airplane_mode_on") -IgnoreErrors
  Write-PrepLog -Category "prep" -Message ("Preflight airplane_mode_on read => exit " + $current.ExitCode + " output=" + $current.Output)
  if ($current.Output.Trim() -eq "0") {
    Write-PrepLog -Category "prep" -Message "Airplane mode already off before prep"
    return
  }

  $result = Set-AirplaneMode -Enabled $false
  if (-not $result) {
    Write-PrepLog -Category "prep" -Message "Preflight airplane-mode disable could not be verified; continuing with radio-reset fallback path"
  }
}

function Disable-LocationServices {
  Write-PrepLog -Category "prep" -Message "Disabling device location services"

  $helperResult = Invoke-MacroDroidHelper -ExtraArguments @(
    "--es", "command_type", "set_system_setting",
    "--es", "setting_type", "secure",
    "--es", "setting_key", "location_mode",
    "--es", "setting_value_type", "int",
    "--es", "setting_value", "0",
    "--es", "macro_name", "PhoneFarm Prep"
  )
  if ($helperResult.ExitCode -eq 0) {
    Write-PrepLog -Category "prep" -Message "MacroDroid Helper accepted location disable request"
  }

  $attempts = @(
    @("shell", "settings", "put", "secure", "location_mode", "0"),
    @("shell", "cmd", "location", "set-location-enabled", "false"),
    @("shell", "settings", "put", "secure", "location_providers_allowed", "-gps"),
    @("shell", "settings", "put", "secure", "location_providers_allowed", "-network")
  )

  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
    Write-PrepLog -Category "prep" -Message ("Location command attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode + " output=" + $result.Output)
  }

  Start-Sleep -Seconds 2
  $modeCheck = Invoke-Adb -Arguments @("-s", $Serial, "shell", "settings", "get", "secure", "location_mode") -IgnoreErrors
  $enabledCheck = Invoke-Adb -Arguments @("-s", $Serial, "shell", "cmd", "location", "is-location-enabled") -IgnoreErrors
  Write-PrepLog -Category "prep" -Message ("Location verify mode => exit " + $modeCheck.ExitCode + " output=" + $modeCheck.Output)
  Write-PrepLog -Category "prep" -Message ("Location verify enabled => exit " + $enabledCheck.ExitCode + " output=" + $enabledCheck.Output)

  $modeDisabled = $modeCheck.Output.Trim() -eq "0"
  $enabledDisabled = $enabledCheck.Output.Trim().ToLowerInvariant() -eq "false"
  if (-not ($modeDisabled -or $enabledDisabled)) {
    throw "Unable to verify that location services are disabled."
  }
}

function Enable-Hotspot {
  Write-PrepLog -Category "prep" -Message "Attempting to re-enable hotspot"

  $attempts = @(
    @("shell", "cmd", "connectivity", "tether", "start", "wifi"),
    @("shell", "cmd", "connectivity", "start-tethering", "wifi")
  )

  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
    Write-PrepLog -Category "prep" -Message ("Hotspot command attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode)
    if ($result.ExitCode -eq 0) {
      return
    }
  }

  throw "Unable to re-enable hotspot through ADB on this device or ROM."
}

function Set-WifiStateWithHelper {
  param([int]$State)

  $result = Invoke-MacroDroidHelper -ExtraArguments @(
    "--es", "command_type", "set_wifi",
    "--ei", "wifi_state", "$State",
    "--es", "macro_name", "PhoneFarm Prep"
  )
  if ($result.ExitCode -eq 0) {
    return $true
  }
  return $false
}

function Ensure-WifiEnabled {
  Write-PrepLog -Category "prep" -Message "Ensuring Wi-Fi is enabled"

  $helperApplied = Set-WifiStateWithHelper -State 1
  Write-PrepLog -Category "prep" -Message ("Wi-Fi helper enable result => " + $helperApplied)

  $attempts = @(
    @("shell", "svc", "wifi", "enable"),
    @("shell", "cmd", "wifi", "set-wifi-enabled", "enabled")
  )

  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
    Write-PrepLog -Category "prep" -Message ("Wi-Fi command attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode)
  }
}

function Ensure-MobileDataEnabled {
  Write-PrepLog -Category "prep" -Message "Ensuring mobile data is enabled"

  $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "svc", "data", "enable") -IgnoreErrors
  Write-PrepLog -Category "prep" -Message ("Mobile data command attempt: adb shell svc data enable => exit " + $result.ExitCode)
}

function Disable-RadiosForReset {
  Write-PrepLog -Category "prep" -Message "Applying radio-reset: disabling Wi-Fi and mobile data"
  $helperApplied = Set-WifiStateWithHelper -State 0
  Write-PrepLog -Category "prep" -Message ("Wi-Fi helper disable result => " + $helperApplied)
  $wifi = Invoke-Adb -Arguments @("-s", $Serial, "shell", "svc", "wifi", "disable") -IgnoreErrors
  $data = Invoke-Adb -Arguments @("-s", $Serial, "shell", "svc", "data", "disable") -IgnoreErrors
  Write-PrepLog -Category "prep" -Message ("Radio reset Wi-Fi disable exit=" + $wifi.ExitCode)
  Write-PrepLog -Category "prep" -Message ("Radio reset data disable exit=" + $data.ExitCode)
}

function Restore-RadiosForRole {
  if ($deviceConfig.role -eq "hotspot-provider") {
    Ensure-MobileDataEnabled
    Enable-Hotspot
    return
  }

  if ($deviceConfig.role -eq "hotspot-client") {
    Ensure-WifiEnabled
    Write-PrepLog -Category "prep" -Message "Device role is hotspot-client; hotspot re-enable skipped"
    return
  }

  Ensure-MobileDataEnabled
  Write-PrepLog -Category "prep" -Message "Device role is sim-direct; waiting for mobile-data recovery"
}

function Wait-ForNetworkRecovery {
  param([int]$TimeoutSeconds)

  Write-PrepLog -Category "prep" -Message "Waiting for device network recovery"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "getprop", "sys.boot_completed") -IgnoreErrors
    $route = Invoke-Adb -Arguments @("-s", $Serial, "shell", "ip", "route") -IgnoreErrors
    $ping1 = Invoke-Adb -Arguments @("-s", $Serial, "shell", "ping", "-c", "1", "1.1.1.1") -IgnoreErrors
    $ping2 = Invoke-Adb -Arguments @("-s", $Serial, "shell", "ping", "-c", "1", "8.8.8.8") -IgnoreErrors
    if (($result.Output -match "1") -and (
        ($route.Output -match "default|src\s+\d{1,3}(?:\.\d{1,3}){3}") -or
        ($ping1.ExitCode -eq 0) -or
        ($ping2.ExitCode -eq 0)
      )) {
      return
    }
    Start-Sleep -Seconds 4
  }
  throw "Client network recovery timed out."
}

function Invoke-RoleAwareRadioReset {
  Write-PrepLog -Category "prep" -Message "Starting role-aware radio reset"
  Ensure-AirplaneModeOff
  Disable-RadiosForReset
  Start-Sleep -Seconds 6
  Restore-RadiosForRole
  Wait-ForNetworkRecovery -TimeoutSeconds $timeout
}

function Invoke-RebootRecovery {
  param([int]$TimeoutSeconds)

  Write-PrepLog -Category "prep" -Message "Falling back to reboot-based recovery"
  $reboot = Invoke-Adb -Arguments @("-s", $Serial, "reboot") -IgnoreErrors
  Write-PrepLog -Category "prep" -Message ("Reboot command attempt => exit " + $reboot.ExitCode + " output=" + $reboot.Output)
  if ($reboot.ExitCode -ne 0) {
    throw "Reboot-based recovery could not start."
  }

  Wait-ForDeviceDisconnect -TimeoutSeconds 30
  Wait-ForDeviceOnline -TimeoutSeconds ($TimeoutSeconds + 120)
  Start-Sleep -Seconds 12
  Ensure-AirplaneModeOff
  Restore-RadiosForRole
  Wait-ForNetworkRecovery -TimeoutSeconds ($TimeoutSeconds + 120)
}

try {
  $settings = Get-Settings
  $deviceConfig = Get-DeviceConfig
  $script:AdbPath = if ($settings.adbPath) { $settings.adbPath } else { "adb" }
  $prepSettings = if ($settings.prep) { $settings.prep } else { [pscustomobject]@{ minWaitSeconds = 25; maxWaitSeconds = 45; onlineTimeoutSeconds = 90 } }
  $minWait = [int]$prepSettings.minWaitSeconds
  $maxWait = [int]$prepSettings.maxWaitSeconds
  $timeout = [int]$prepSettings.onlineTimeoutSeconds
  $randomWait = Get-Random -Minimum $minWait -Maximum ($maxWait + 1)
  Write-PrepLog -Category "prep" -Message "Prep sequence started"
  Wait-ForDeviceOnline -TimeoutSeconds $timeout
  Ensure-AirplaneModeOff
  Disable-LocationServices
  Write-PrepLog -Category "prep" -Message "Sleeping for randomized hold: $randomWait seconds"
  Start-Sleep -Seconds $randomWait
  try {
    Invoke-RoleAwareRadioReset
  }
  catch {
    Write-PrepLog -Category "prep" -Message ("Role-aware radio reset failed: " + $_.Exception.Message + ". Falling back to reboot recovery.")
    Invoke-RebootRecovery -TimeoutSeconds $timeout
    Wait-ForDeviceOnline -TimeoutSeconds $timeout
  }
  Disable-LocationServices
  Write-PrepLog -Category "prep" -Message "Prep sequence completed successfully"
  exit 0
}
catch {
  Write-PrepLog -Category "prep" -Message ("Prep sequence failed: " + $_.Exception.Message)
  exit 1
}
