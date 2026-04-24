param()

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptUnderTest = Join-Path $PSScriptRoot "set-device-wifi-state.ps1"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("routerfarm-wifi-state-test-" + [guid]::NewGuid().ToString("N"))
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

  $scenario = switch ($ScenarioName) {
    "helper-enable" {
      @{ state = "enable" }
    }
    "helper-disable" {
      @{ state = "disable" }
    }
    default {
      throw "Unknown scenario '$ScenarioName'"
    }
  }

  $initialState = @{
    wifiEnabled = $false
    helperCalls = 0
    svcCalls = 0
    cmdCalls = 0
    events = @()
  }

  ($scenario | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $scenarioPath -Encoding UTF8
  ($initialState | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $statePath -Encoding UTF8
  (@{ adbPath = $adbCmdPath } | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $settingsPath -Encoding UTF8

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
  $events = @($NextState.events)
  $NextState.events = @($events + $Event)
}

$joined = $CliArgs -join " "
Add-Event -NextState $state -Event $joined

if ($joined -match "shell am broadcast .*command_type.*set_wifi.*wifi_state.*1") {
  $state.helperCalls = [int]$state.helperCalls + 1
  $state.wifiEnabled = $true
  Save-State $state
  Write-Output "Broadcast completed: result=0"
  exit 0
}

if ($joined -match "shell am broadcast .*command_type.*set_wifi.*wifi_state.*0") {
  $state.helperCalls = [int]$state.helperCalls + 1
  $state.wifiEnabled = $false
  Save-State $state
  Write-Output "Broadcast completed: result=0"
  exit 0
}

if ($joined -match "shell svc wifi ") {
  $state.svcCalls = [int]$state.svcCalls + 1
  Save-State $state
  [Console]::Error.WriteLine("Security exception: svc wifi blocked")
  exit 1
}

if ($joined -match "shell cmd wifi set-wifi-enabled ") {
  $state.cmdCalls = [int]$state.cmdCalls + 1
  Save-State $state
  [Console]::Error.WriteLine("Security exception: cmd wifi blocked")
  exit 1
}

if ($joined -match "shell settings get global wifi_on") {
  if ($state.wifiEnabled) {
    Write-Output "1"
  } else {
    Write-Output "0"
  }
  Save-State $state
  exit 0
}

if ($joined -match "shell dumpsys wifi") {
  if ($state.wifiEnabled) {
    Write-Output "Wi-Fi is enabled"
  } else {
    Write-Output "Wi-Fi is disabled"
  }
  Save-State $state
  exit 0
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
  }
}

function Invoke-Scenario {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScenarioName,

    [Parameter(Mandatory = $true)]
    [string]$State
  )

  $harness = New-TestHarness -ScenarioName $ScenarioName
  $previousScenario = $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH
  $previousState = $env:ROUTERFARM_FAKE_ADB_STATE_PATH
  try {
    $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH = $harness.ScenarioPath
    $env:ROUTERFARM_FAKE_ADB_STATE_PATH = $harness.StatePath

    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptUnderTest -Serial "TEST123" -State $State -SettingsPath $harness.SettingsPath 2>&1
    $exitCode = $LASTEXITCODE
    $payload = $output | Select-Object -Last 1 | ConvertFrom-Json
    $stateFile = Get-Content -LiteralPath $harness.StatePath -Raw | ConvertFrom-Json
    [pscustomobject]@{
      ExitCode = $exitCode
      Payload = $payload
      State = $stateFile
      RawOutput = [string]($output | Out-String)
    }
  } finally {
    $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH = $previousScenario
    $env:ROUTERFARM_FAKE_ADB_STATE_PATH = $previousState
  }
}

try {
  $enableResult = Invoke-Scenario -ScenarioName "helper-enable" -State "enable"
  Assert-True ($enableResult.ExitCode -eq 0) ("Helper-enable scenario should exit 0. Raw output:`n" + $enableResult.RawOutput)
  Assert-True ([bool]$enableResult.Payload.ok) "Helper-enable scenario should report ok=true."
  Assert-True ([bool]$enableResult.State.wifiEnabled) "Helper-enable scenario should end with Wi-Fi enabled."
  Assert-True ([int]$enableResult.State.helperCalls -ge 1) "Helper-enable scenario should use MacroDroid Helper."

  $disableResult = Invoke-Scenario -ScenarioName "helper-disable" -State "disable"
  Assert-True ($disableResult.ExitCode -eq 0) ("Helper-disable scenario should exit 0. Raw output:`n" + $disableResult.RawOutput)
  Assert-True ([bool]$disableResult.Payload.ok) "Helper-disable scenario should report ok=true."
  Assert-True (-not [bool]$disableResult.State.wifiEnabled) "Helper-disable scenario should end with Wi-Fi disabled."
  Assert-True ([int]$disableResult.State.helperCalls -ge 1) "Helper-disable scenario should use MacroDroid Helper."

  Write-Output '{"ok":true,"message":"set-device-wifi-state tests passed"}'
  exit 0
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
