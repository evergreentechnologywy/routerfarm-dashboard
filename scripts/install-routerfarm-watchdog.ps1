param(
  [string]$TaskName = "RouterFarm Watchdog",
  [string]$ScriptPath = "C:\Users\everg\routerfarm-release\scripts\watch-routerfarm.ps1"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "Watchdog script not found at $ScriptPath"
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Monitor RouterFarm and restart it if the packaged app or local backend stops responding." -Force | Out-Null

[pscustomobject]@{
  ok = $true
  taskName = $TaskName
  scriptPath = $ScriptPath
} | ConvertTo-Json -Compress
