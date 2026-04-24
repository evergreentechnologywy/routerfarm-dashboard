param()

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptUnderTest = Join-Path $PSScriptRoot "connect-phone-to-router.ps1"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("routerfarm-connect-test-" + [guid]::NewGuid().ToString("N"))
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
    "ui-success" {
      @{
        mode = "ui-success"
        targetSsid = "VIVINT-TRVL-f77"
        password = "c95db1c6"
      }
    }
    "hidden-network-success" {
      @{
        mode = "hidden-network-success"
        targetSsid = "VIVINT-TRVL-f77"
        password = "c95db1c6"
      }
    }
    "retry-failure" {
      @{
        mode = "retry-failure"
        targetSsid = "VIVINT-TRVL-f77"
        password = "c95db1c6"
      }
    }
    default {
      throw "Unknown scenario '$ScenarioName'"
    }
  }

  $initialState = @{
    wifiEnabled = $false
    screen = ""
    connected = $false
    passwordEntered = $false
    ssidEntered = $false
    ssidValue = ""
    activeField = ""
    securitySelected = $false
    addNetworkOpenCount = 0
    securityPickerOpenCount = 0
    saveTapCount = 0
    targetTapCount = 0
    connectTapCount = 0
    directCommandCount = 0
    uiaDumpCount = 0
    dumpsysCount = 0
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

function Write-Xml {
  param([string]$Screen, [string]$TargetSsid)

  if ($Screen -eq "security-picker") {
@"
<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="1">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" bounds="[203,238][612,480]">
    <node index="0" text="" resource-id="" class="android.widget.ListView" package="com.android.settings" bounds="[203,238][612,480]">
      <node index="0" text="Ninguna" resource-id="android:id/text1" class="android.widget.CheckedTextView" package="com.android.settings" bounds="[203,238][612,310]" />
      <node index="1" text="WEP" resource-id="android:id/text1" class="android.widget.CheckedTextView" package="com.android.settings" bounds="[203,310][612,382]" />
      <node index="2" text="WPA/WPA2 PSK" resource-id="android:id/text1" class="android.widget.CheckedTextView" package="com.android.settings" bounds="[203,382][612,454]" />
    </node>
  </node>
</hierarchy>
"@
    return
  }

  if ($Screen -eq "add-network") {
    $ssidText = if ($state.ssidEntered) { $state.ssidValue } else { "Ingrese el SSID" }
    $securityText = if ($state.securitySelected) { "WPA/WPA2 PSK" } else { "Ninguna" }
    $saveEnabled = if ($state.ssidEntered -and $state.securitySelected -and $state.passwordEntered) { "true" } else { "false" }
@"
<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="1">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" bounds="[155,36][732,480]">
    <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" bounds="[179,60][708,456]">
      <node index="0" text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.android.settings" bounds="[179,60][708,456]">
        <node index="0" text="" resource-id="android:id/parentPanel" class="android.widget.LinearLayout" package="com.android.settings" bounds="[179,60][708,456]">
          <node index="0" text="" resource-id="android:id/topPanel" class="android.widget.LinearLayout" package="com.android.settings" bounds="[179,60][708,128]">
            <node index="0" text="" resource-id="android:id/title_template" class="android.widget.LinearLayout" package="com.android.settings" bounds="[179,60][708,128]">
              <node index="0" text="Añadir red" resource-id="android:id/alertTitle" class="android.widget.TextView" package="com.android.settings" bounds="[215,87][672,128]" />
            </node>
          </node>
          <node index="1" text="" resource-id="android:id/customPanel" class="android.widget.FrameLayout" package="com.android.settings" bounds="[179,128][708,372]">
            <node index="0" text="" resource-id="android:id/custom" class="android.widget.FrameLayout" package="com.android.settings" bounds="[179,128][708,372]">
              <node index="0" text="" resource-id="" class="android.widget.ScrollView" package="com.android.settings" bounds="[179,128][708,372]">
                <node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" bounds="[179,128][708,372]">
                  <node index="0" text="" resource-id="com.android.settings:id/type" class="android.widget.LinearLayout" package="com.android.settings" bounds="[179,128][708,216]">
                    <node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" bounds="[191,140][696,216]">
                      <node index="0" text="Red SSID" resource-id="" class="android.widget.TextView" package="com.android.settings" bounds="[203,140][300,169]" />
                      <node index="1" text="$ssidText" resource-id="com.android.settings:id/ssid" class="android.widget.EditText" package="com.android.settings" bounds="[209,169][684,237]" />
                    </node>
                    <node index="1" text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" bounds="[191,249][696,350]">
                      <node index="0" text="Seguridad" resource-id="" class="android.widget.TextView" package="com.android.settings" bounds="[203,249][587,278]" />
                      <node index="1" text="" resource-id="com.android.settings:id/security" class="android.widget.Spinner" package="com.android.settings" bounds="[203,278][684,350]">
                        <node index="0" text="$securityText" resource-id="android:id/text1" class="android.widget.TextView" package="com.android.settings" bounds="[203,297][612,330]" />
                      </node>
                    </node>
                  </node>
                  <node index="1" text="" resource-id="com.android.settings:id/security_fields" class="android.widget.LinearLayout" package="com.android.settings" bounds="[179,216][708,372]">
                    <node index="0" text="" resource-id="com.android.settings:id/password_layout" class="android.widget.LinearLayout" package="com.android.settings" bounds="[191,228][696,325]">
                      <node index="0" text="Contraseña" resource-id="" class="android.widget.TextView" package="com.android.settings" bounds="[203,228][323,257]" />
                      <node index="1" text="" resource-id="com.android.settings:id/password" class="android.widget.EditText" package="com.android.settings" bounds="[209,257][684,325]" />
                    </node>
                  </node>
                </node>
              </node>
            </node>
          </node>
          <node index="2" text="" resource-id="android:id/buttonPanel" class="android.widget.ScrollView" package="com.android.settings" bounds="[179,372][708,456]">
            <node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" bounds="[179,372][708,456]">
              <node index="0" text="CANCELAR" resource-id="android:id/button2" class="android.widget.Button" package="com.android.settings" bounds="[415,378][558,450]" />
              <node index="1" text="GUARDAR" resource-id="android:id/button1" class="android.widget.Button" package="com.android.settings" enabled="$saveEnabled" bounds="[558,378][690,450]" />
            </node>
          </node>
        </node>
      </node>
    </node>
  </node>
</hierarchy>
"@
    return
  }

  if ($Screen -eq "password") {
@"
<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Enter password" resource-id="" class="android.widget.TextView" package="com.android.settings" bounds="[20,40][500,100]" />
  <node index="1" text="" resource-id="com.android.settings:id/password" class="android.widget.EditText" package="com.android.settings" bounds="[20,120][500,220]" />
  <node index="2" text="Connect" resource-id="" class="android.widget.Button" package="com.android.settings" bounds="[280,300][500,380]" />
</hierarchy>
"@
      return
    }

  if ($scenario.mode -eq "retry-failure" -or $scenario.mode -eq "hidden-network-success") {
@"
<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Wi-Fi preferences" resource-id="" class="android.widget.TextView" package="com.android.settings" bounds="[20,40][500,100]" />
  <node index="1" text="CoffeeShopGuest" resource-id="" class="android.widget.TextView" package="com.android.settings" bounds="[20,120][500,200]" />
</hierarchy>
"@
      return
    }

@"
<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Wi-Fi preferences" resource-id="" class="android.widget.TextView" package="com.android.settings" bounds="[20,40][500,100]" />
  <node index="1" text="$TargetSsid" resource-id="" class="android.widget.TextView" package="com.android.settings" bounds="[20,120][500,200]" />
</hierarchy>
"@
}

$joined = $CliArgs -join " "
Add-Event -NextState $state -Event $joined

if ($joined -match "shell svc wifi enable") {
  $state.wifiEnabled = $true
  Save-State $state
  exit 0
}

if ($joined -match "shell cmd(?: -w)? wifi connect-network") {
  $state.directCommandCount = [int]$state.directCommandCount + 1
  Save-State $state
  [Console]::Error.WriteLine("Security exception: Uid 2000 does not have access to wifi commands")
  exit 1
}

if ($joined -match "shell am start -a android.settings.WIFI_SETTINGS") {
  $state.screen = "wifi-list"
  Save-State $state
  exit 0
}

if ($joined -match "shell am start -n com.android.settings/.wifi.WifiDialogActivity") {
  $state.screen = "add-network"
  $state.activeField = "ssid"
  $state.addNetworkOpenCount = [int]$state.addNetworkOpenCount + 1
  Save-State $state
  exit 0
}

if ($joined -match "shell uiautomator dump /sdcard/routerfarm-window.xml") {
  $state.uiaDumpCount = [int]$state.uiaDumpCount + 1
  Save-State $state
  Write-Output "UI hierchary dumped to: /sdcard/routerfarm-window.xml"
  exit 0
}

if ($joined -match "shell cat /sdcard/routerfarm-window.xml") {
  Write-Output (Write-Xml -Screen ([string]$state.screen) -TargetSsid ([string]$scenario.targetSsid))
  Save-State $state
  exit 0
}

if ($joined -match "shell input tap (\d+) (\d+)") {
  $x = [int]$Matches[1]
  $y = [int]$Matches[2]
  if ($state.screen -eq "wifi-list" -and $x -ge 20 -and $x -le 500 -and $y -ge 120 -and $y -le 200 -and $scenario.mode -eq "ui-success") {
    $state.screen = "password"
    $state.targetTapCount = [int]$state.targetTapCount + 1
  } elseif ($state.screen -eq "add-network" -and $x -ge 209 -and $x -le 684 -and $y -ge 169 -and $y -le 237) {
    $state.activeField = "ssid"
  } elseif ($state.screen -eq "add-network" -and $state.securitySelected -and $x -ge 209 -and $x -le 684 -and $y -ge 257 -and $y -le 325) {
    $state.activeField = "password"
  } elseif ($state.screen -eq "add-network" -and (-not $state.securitySelected) -and $x -ge 203 -and $x -le 684 -and $y -ge 278 -and $y -le 350) {
    $state.screen = "security-picker"
    $state.securityPickerOpenCount = [int]$state.securityPickerOpenCount + 1
  } elseif ($state.screen -eq "security-picker" -and $x -ge 203 -and $x -le 612 -and $y -ge 382 -and $y -le 454) {
    $state.screen = "add-network"
    $state.securitySelected = $true
  } elseif ($state.screen -eq "add-network" -and $x -ge 558 -and $x -le 690 -and $y -ge 378 -and $y -le 450) {
    $state.saveTapCount = [int]$state.saveTapCount + 1
    if ($scenario.mode -eq "hidden-network-success" -and $state.ssidEntered -and $state.securitySelected -and $state.passwordEntered) {
      $state.connected = $true
      $state.screen = "wifi-list"
    }
  } elseif ($state.screen -eq "password" -and $x -ge 280 -and $x -le 500 -and $y -ge 300 -and $y -le 380) {
    $state.connectTapCount = [int]$state.connectTapCount + 1
    if ($state.passwordEntered) {
      $state.connected = $true
      $state.screen = "wifi-list"
    }
  }
  Save-State $state
  exit 0
}

if ($joined -match "shell input text ") {
  if ($state.screen -eq "password") {
    $state.passwordEntered = $true
  } elseif ($state.screen -eq "add-network" -and $state.activeField -eq "ssid") {
    $state.ssidEntered = $true
    $state.ssidValue = [string]$scenario.targetSsid
  } elseif ($state.screen -eq "add-network" -and $state.activeField -eq "password") {
    $state.passwordEntered = $true
  }
  Save-State $state
  exit 0
}

if ($joined -match "shell input swipe ") {
  Save-State $state
  exit 0
}

if ($joined -match "shell input keyevent ") {
  Save-State $state
  exit 0
}

if ($joined -match "shell dumpsys wifi") {
  $state.dumpsysCount = [int]$state.dumpsysCount + 1
  Save-State $state
  if ($state.connected) {
    Write-Output 'WifiInfo: SSID: "VIVINT-TRVL-f77", BSSID: 94:83:C4:74:53:E5'
    exit 0
  }
  Write-Output "WifiConfigManager - Configured networks Begin ----`nWifiConfigManager - Configured networks End ----"
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
    [string]$ScenarioName
  )

  $harness = New-TestHarness -ScenarioName $ScenarioName
  $previousScenario = $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH
  $previousState = $env:ROUTERFARM_FAKE_ADB_STATE_PATH
  try {
    $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH = $harness.ScenarioPath
    $env:ROUTERFARM_FAKE_ADB_STATE_PATH = $harness.StatePath

    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptUnderTest -Serial "TEST123" -Ssid "VIVINT-TRVL-f77" -Password "c95db1c6" -SettingsPath $harness.SettingsPath 2>&1
    $exitCode = $LASTEXITCODE
    $payload = $output | Select-Object -Last 1 | ConvertFrom-Json
    $state = Get-Content -LiteralPath $harness.StatePath -Raw | ConvertFrom-Json
    [pscustomobject]@{
      ExitCode = $exitCode
      Payload = $payload
      State = $state
      RawOutput = [string]($output | Out-String)
    }
  } finally {
    $env:ROUTERFARM_FAKE_ADB_SCENARIO_PATH = $previousScenario
    $env:ROUTERFARM_FAKE_ADB_STATE_PATH = $previousState
  }
}

try {
  $uiSuccess = Invoke-Scenario -ScenarioName "ui-success"
  Assert-True ($uiSuccess.ExitCode -eq 0) ("UI success scenario should exit 0. Raw output:`n" + $uiSuccess.RawOutput)
  Assert-True ([bool]$uiSuccess.Payload.ok) "UI success scenario should report ok=true."
  Assert-True (-not [bool]$uiSuccess.Payload.requiresManualAssist) "UI success scenario should not fall back to manual assist."
  Assert-True ($uiSuccess.Payload.method -match "ui-automation") "UI success scenario should report the UI automation method."
  Assert-True ($uiSuccess.Payload.connectedSsid -eq "VIVINT-TRVL-f77") "UI success scenario should verify the target SSID."
  Assert-True ([int]$uiSuccess.State.targetTapCount -ge 1) "UI success scenario should tap the target SSID."
  Assert-True ([int]$uiSuccess.State.connectTapCount -ge 1) "UI success scenario should tap the Connect button."
  Assert-True ([int]$uiSuccess.State.dumpsysCount -ge 1) "UI success scenario should verify Wi-Fi association."

  $hiddenNetworkSuccess = Invoke-Scenario -ScenarioName "hidden-network-success"
  Assert-True ($hiddenNetworkSuccess.ExitCode -eq 0) ("Hidden-network scenario should exit 0. Raw output:`n" + $hiddenNetworkSuccess.RawOutput)
  Assert-True ([bool]$hiddenNetworkSuccess.Payload.ok) "Hidden-network scenario should report ok=true."
  Assert-True ($hiddenNetworkSuccess.Payload.method -match "add-network") "Hidden-network scenario should report the add-network method."
  Assert-True ([int]$hiddenNetworkSuccess.State.addNetworkOpenCount -ge 1) "Hidden-network scenario should open the Add network dialog."
  Assert-True ([int]$hiddenNetworkSuccess.State.securityPickerOpenCount -ge 1) "Hidden-network scenario should open the security picker."
  Assert-True ([bool]$hiddenNetworkSuccess.State.securitySelected) "Hidden-network scenario should select WPA/WPA2 PSK security."
  Assert-True ([bool]$hiddenNetworkSuccess.State.ssidEntered) "Hidden-network scenario should enter the target SSID."
  Assert-True ([bool]$hiddenNetworkSuccess.State.passwordEntered) "Hidden-network scenario should enter the Wi-Fi password."
  Assert-True ([int]$hiddenNetworkSuccess.State.saveTapCount -ge 1) "Hidden-network scenario should tap the Save button."

  $retryFailure = Invoke-Scenario -ScenarioName "retry-failure"
  Assert-True ($retryFailure.ExitCode -ne 0) "Retry failure scenario should exit non-zero."
  Assert-True (-not [bool]$retryFailure.Payload.ok) "Retry failure scenario should report ok=false."
  Assert-True ([int]$retryFailure.Payload.retryCount -eq 3) "Retry failure scenario should stop after exactly 3 attempts."
  Assert-True (-not [bool]$retryFailure.Payload.requiresManualAssist) "Retry failure scenario should fail automatically instead of leaving manual assist."

  Write-Output '{"ok":true,"message":"connect-phone-to-router tests passed"}'
  exit 0
} finally {
  if ($env:ROUTERFARM_KEEP_TEST_TEMP -ne "1") {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Output ("Retained temp test root: " + $tempRoot)
  }
}
