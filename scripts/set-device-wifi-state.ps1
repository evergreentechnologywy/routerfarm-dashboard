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
    [string]$Message
  )

  @{
    ok = $Success
    serial = $Serial
    state = $State
    message = $Message
    checkedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json -Compress
}

$settings = if (Test-Path -LiteralPath $SettingsPath) {
  Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
} else {
  $null
}
$adbPath = if ($settings -and $settings.adbPath) { [string]$settings.adbPath } else { "adb" }

try {
  $output = & $adbPath "-s" $Serial "shell" "svc" "wifi" $State 2>&1
  $exitCode = $LASTEXITCODE
} catch {
  $output = $_.Exception.Message
  $exitCode = 1
}

if ($exitCode -eq 0) {
  Write-Result -Success:$true -Message "Wi-Fi $State requested."
  exit 0
}

Write-Result -Success:$false -Message ([string]($output | Out-String).Trim())
exit 1
