param()

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$scriptUnderTest = Join-Path $PSScriptRoot "prep-device-session.ps1"
$projectRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("routerfarm-prep-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function New-TestHarness {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScenarioName
  )

  $scenarioPath = Join-Path $tempRoot "$ScenarioName.scenario.json"
  $statePath = Join-Path $tempRoot "$ScenarioName.state.json"
  $settingsPath = Join-Path $tempRoot "$ScenarioName.settings.json"
  $adbScriptPath = Join-Path $tempRoot "$ScenarioName.fake-adb.ps1"
  $adbCmdPath = Join-Path $tempRoot "$ScenarioName.fake-adb.cmd"
  $configRoot = Join-Path $tempRoot "$ScenarioName.project"
  $configDir = Join-Path $configRoot "config"
  $logsDir = Join-Path $configRoot "logs"
  $scriptsDir = Join-Path $configRoot "scripts"

  New-Item -ItemType Directory -Path $configDir -Force | Out-Null
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
  New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null

  $scenario = switch ($ScenarioName) {
    "router-linkpro-cellular-only" {
      @{
        role = "router-linkpro"
        route = "10.145.48.224/29 dev rmnet_data0 proto kernel scope link src 10.145.48.227"
        pingExitCode = 0
        rebootExitCode = 1
      }
    }
    "router-linkpro-wifi-route" {
      @{
        role = "router-linkpro"
        route = "default via 192.168.16.1 dev wlan0 proto static`n192.168.16.0/24 dev wlan0 proto kernel scope link src 192.168.16.22"
        pingExitCode = 0
        rebootExitCode = 0
      }
    }
    default {
      throw "Unknown scenario '$ScenarioName'"
    }
  }

  $initialState = @{
    rebootRequested = $false
    events = @()
  }

  ($scenario | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $scenarioPath -Encoding UTF8
  ($initialState | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $statePath -Encoding UTF8
  (@{
      adbPath = $adbCmdPath
      prep = @{
        minWaitSeconds = 0
        maxWaitSeconds = 0
        onlineTimeoutSeconds = 1
      }
    } | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $settingsPath -Encoding UTF8
  (@{
      devices = @(
        @{
          serial = "TEST123"
          role = $scenario.role
          routerId = "opal-06"
          routerSlot = 5
        }
      )
    } | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath (Join-Path $configDir "devices.json") -Encoding UTF8
  Copy-Item -LiteralPath $scriptUnderTest -Destination (Join-Path $scriptsDir "prep-device-session.ps1")

  $adbScript = @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)

$ErrorActionPreference = "Stop"
$statePath = $env:ROUTERFARM_FAKE_ADB_STATE_PATH
$scenarioPath = $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$scenario = Get-Content -LiteralPath $scenarioPath -Raw | ConvertFrom-Json

function Save-State {
  param($NextState)
  ($NextState | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Add-Event {
  param($NextState, [string]$Event)
  $NextState.events = @(@($NextState.events) + $Event)
}

$joined = $CliArgs -join " "
Add-Event -NextState $state -Event $joined

if ($joined -match "^-s TEST123 get-state$") {
  Save-State $state
  Write-Output "device"
  exit 0
}

if ($joined -match "shell settings get global airplane_mode_on") {
  Save-State $state
  Write-Output "0"
  exit 0
}

if ($joined -match "shell settings get secure location_mode") {
  Save-State $state
  Write-Output "0"
  exit 0
}

if ($joined -match "shell cmd location is-location-enabled") {
  Save-State $state
  Write-Output "false"
  exit 0
}

if ($joined -match "shell getprop sys.boot_completed") {
  Save-State $state
  Write-Output "1"
  exit 0
}

if ($joined -match "shell ip route") {
  Save-State $state
  Write-Output $scenario.route
  exit 0
}

if ($joined -match "shell ping -c 1 ") {
  Save-State $state
  if ([int]$scenario.pingExitCode -eq 0) {
    Write-Output "1 packets transmitted, 1 received"
  }
  exit ([int]$scenario.pingExitCode)
}

if ($joined -match "^-s TEST123 reboot$") {
  $state.rebootRequested = $true
  Save-State $state
  if ([int]$scenario.rebootExitCode -eq 0) {
    exit 0
  }
  Write-Output "reboot rejected"
  exit ([int]$scenario.rebootExitCode)
}

Save-State $state
exit 0
'@
  Set-Content -LiteralPath $adbScriptPath -Value $adbScript -Encoding UTF8
  Set-Content -LiteralPath $adbCmdPath -Value "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$adbScriptPath`" %*`r`nexit /b %errorlevel%`r`n" -Encoding ASCII

  return [pscustomobject]@{
    ScenarioPath = $scenarioPath
    StatePath = $statePath
    SettingsPath = $settingsPath
    ConfigRoot = $configRoot
    ScriptPath = Join-Path $scriptsDir "prep-device-session.ps1"
  }
}

function Invoke-Scenario {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScenarioName
  )

  $harness = New-TestHarness -ScenarioName $ScenarioName
  $previousScenario = $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH
  $previousState = $env:ROUTERFARM_FAKE_ADB_STATE_PATH
  try {
    $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH = $harness.ScenarioPath
    $env:ROUTERFARM_FAKE_ADB_STATE_PATH = $harness.StatePath

    $activityLogPath = Join-Path $harness.ConfigRoot "logs\\activity.log"
    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $harness.ScriptPath -Serial "TEST123" -SettingsPath $harness.SettingsPath -ActivityLogPath $activityLogPath 2>&1
    $exitCode = $LASTEXITCODE
    $state = Get-Content -LiteralPath $harness.StatePath -Raw | ConvertFrom-Json
    $logPath = Join-Path $harness.ConfigRoot "logs\\prep-TEST123.log"
    $logContent = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
    [pscustomobject]@{
      ExitCode = $exitCode
      State = $state
      LogContent = [string]$logContent
      RawOutput = [string]($output | Out-String)
    }
  } finally {
    $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH = $previousScenario
    $env:ROUTERFARM_FAKE_ADB_STATE_PATH = $previousState
  }
}

try {
  $cellularOnly = Invoke-Scenario -ScenarioName "router-linkpro-cellular-only"
  Assert-True ($cellularOnly.ExitCode -ne 0) ("Router-linkpro cellular-only scenario should fail. Raw output:`n" + $cellularOnly.RawOutput)
  Assert-True ($cellularOnly.LogContent -match "Client network recovery timed out|Reboot-based recovery could not start") "Router-linkpro cellular-only scenario should fail network recovery."
  Assert-True ([bool]$cellularOnly.State.rebootRequested) "Router-linkpro cellular-only scenario should attempt reboot fallback after Wi-Fi recovery times out."

  $wifiRoute = Invoke-Scenario -ScenarioName "router-linkpro-wifi-route"
  Assert-True ($wifiRoute.ExitCode -eq 0) ("Router-linkpro Wi-Fi route scenario should succeed. Raw output:`n" + $wifiRoute.RawOutput)
  Assert-True ($wifiRoute.LogContent -match "Prep sequence completed successfully") "Router-linkpro Wi-Fi route scenario should complete prep successfully."

  Write-Output '{"ok":true,"message":"prep-device-session tests passed"}'
  exit 0
} finally {
  if ($env:ROUTERFARM_KEEP_TEST_TEMP -ne "1") {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Output ("Retained temp test root: " + $tempRoot)
  }
}
