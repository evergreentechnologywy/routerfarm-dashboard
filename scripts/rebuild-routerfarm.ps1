# Rebuild and Refresh RouterFarm Deployment
$ErrorActionPreference = "Stop"

$root = "C:\Users\everg\routerfarm-release"
$scriptsDir = Join-Path $root "scripts"
$watchdogScript = Join-Path $scriptsDir "watch-routerfarm.ps1"

Write-Host "Stopping RouterFarm processes..."
Get-Process RouterFarm -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*server.js*" } | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "Updating Watchdog script..."
$c = 'param([string]$ExePath="C:\Users\everg\routerfarm-release\dist\win-unpacked\RouterFarm.exe",[string]$ServerScript="C:\Users\everg\routerfarm-release\server.js",[string]$StatusUrl="http://127.0.0.1:7781/api/status",[int]$PollSeconds=20,[string]$LogPath="C:\Users\everg\routerfarm-release\logs\watch-routerfarm.log")'
$c += "`n" + 'function Write-WatchLog([string]$m){$t=Get-Date -Format "yyyy-MM-dd HH:mm:ss";"[$t] $m"|Add-Content -Path $LogPath}'
$c += "`n" + 'while($true){try{$h=$false;try{$r=Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 5;$h=[bool]$r.ok}catch{$h=$false};if(-not $h){Write-WatchLog "Server down. Restarting...";Get-Process node -ErrorAction SilentlyContinue|Where-Object{$_.CommandLine -like "*server.js*"}|Stop-Process -Force -ErrorAction SilentlyContinue;Start-Process "node.exe" -ArgumentList $ServerScript -WorkingDirectory (Split-Path $ServerScript) -WindowStyle Hidden;Start-Sleep -Seconds 10};if(-not (Get-Process RouterFarm -ErrorAction SilentlyContinue)){Write-WatchLog "App down. Restarting...";Start-Process $ExePath -WorkingDirectory (Split-Path (Split-Path $ExePath))}}catch{Write-WatchLog "Error: $($_.Exception.Message)"};Start-Sleep -Seconds $PollSeconds}'
Set-Content -Path $watchdogScript -Value $c

Write-Host "Re-installing Watchdog Task..."
& powershell.exe -ExecutionPolicy Bypass -File (Join-Path $scriptsDir "install-routerfarm-watchdog.ps1")

Write-Host "Rebuild Complete."
