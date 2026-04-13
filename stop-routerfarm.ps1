param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidPath = Join-Path $root "routerfarm.pid"

if (-not (Test-Path $pidPath)) {
  Write-Output "RouterFarm PID file not found."
  exit 0
}

$nodePidValue = (Get-Content -Raw -Path $pidPath).Trim()
if (-not $nodePidValue) {
  Write-Output "RouterFarm PID file is empty."
  exit 0
}

$process = Get-Process -Id $nodePidValue -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $nodePidValue -Force
  Write-Output "Stopped RouterFarm PID $nodePidValue"
} else {
  Write-Output "No running process found for PID $nodePidValue"
}

if (Test-Path $pidPath) {
  Remove-Item -LiteralPath $pidPath -Force
}
