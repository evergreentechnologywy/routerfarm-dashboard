param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidPath = Join-Path $root "routerfarm.pid"
$stdoutPath = Join-Path $root "logs\\dashboard-stdout.log"
$stderrPath = Join-Path $root "logs\\dashboard-stderr.log"

if (Test-Path $pidPath) {
  $existingPid = (Get-Content -Raw -Path $pidPath).Trim()
  if ($existingPid) {
    $running = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($running) {
      Write-Output "RouterFarm is already running with PID $existingPid"
      exit 0
    }
    Remove-Item -LiteralPath $pidPath -Force
  }
}

$nodeCommand = Get-Command node -ErrorAction Stop
Start-Process -FilePath $nodeCommand.Source -WorkingDirectory $root -ArgumentList @("server.js") -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden
Start-Sleep -Seconds 2
& (Join-Path $root "scripts\\healthcheck-routerfarm.ps1")
