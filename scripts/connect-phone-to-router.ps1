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
  }

  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }

  $payload | ConvertTo-Json -Depth 6 -Compress
}

$settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
$adbPath = if ($settings.adbPath) { [string]$settings.adbPath } else { "adb" }

function Invoke-Adb {
  param(
    [string[]]$Arguments
  )

  try {
    $output = & $adbPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  catch {
    $output = $_.Exception.Message
    $exitCode = 1
  }

  [pscustomobject]@{
    ExitCode = $exitCode
    Output = [string]($output | Out-String).Trim()
  }
}

Invoke-Adb -Arguments @("-s", $Serial, "shell", "svc", "wifi", "enable") | Out-Null
Start-Sleep -Seconds 2

$escapedSsid = '"' + $Ssid.Replace('"', '\"') + '"'
$escapedPassword = '"' + $Password.Replace('"', '\"') + '"'

$commands = @(
  @("shell", "cmd", "wifi", "connect-network", "wpa2", $Ssid, $Password),
  @("shell", "cmd", "-w", "wifi", "connect-network", "wpa2", $Ssid, $Password),
  @("shell", "am", "start", "-a", "android.settings.WIFI_SETTINGS")
)

foreach ($command in $commands) {
  $result = Invoke-Adb -Arguments (@("-s", $Serial) + $command)
  if ($result.ExitCode -eq 0) {
    $requiresManualAssist = ($command -join " ") -like "shell am start*"
    Write-Result -Success:$true -Message "Phone-side Wi-Fi connect command accepted." -Extra @{
      method = ($command -join " ")
      detail = $result.Output
      requiresManualAssist = $requiresManualAssist
    }
    exit 0
  }

  $detail = $result.Output
  if ($detail -match "does not have access to wifi commands") {
    $manualCommand = @("shell", "am", "start", "-a", "android.settings.WIFI_SETTINGS")
    $manualResult = Invoke-Adb -Arguments (@("-s", $Serial) + $manualCommand)
    if ($manualResult.ExitCode -eq 0) {
      Write-Result -Success:$true -Message "Direct Wi-Fi connect is blocked on this Android build. Wi-Fi settings were opened for manual completion." -Extra @{
        method = ($manualCommand -join " ")
        detail = $manualResult.Output
        requiresManualAssist = $true
      }
      exit 0
    }
  }
}

Write-Result -Success:$false -Message "Phone-side Wi-Fi connect command could not be completed." -Extra @{
  requiresManualAssist = $true
}
exit 1
