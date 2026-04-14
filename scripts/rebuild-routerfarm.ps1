param(
  [string]$Root = "C:\Users\everg\routerfarm-release",
  [string]$ExePath = "C:\Users\everg\routerfarm-release\dist\win-unpacked\RouterFarm.exe",
  [string]$LockPath = "C:\Users\everg\routerfarm-release\logs\watch-routerfarm.maintenance.lock"
)

$ErrorActionPreference = "Stop"

function Set-MaintenanceLock {
  $dir = Split-Path -Parent $LockPath
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  Set-Content -LiteralPath $LockPath -Value ("build-started={0}" -f ([DateTime]::Now.ToString("s")))
}

function Clear-MaintenanceLock {
  if (Test-Path -LiteralPath $LockPath) {
    Remove-Item -LiteralPath $LockPath -Force
  }
}

try {
  Set-MaintenanceLock
  Get-Process RouterFarm -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  node "$Root\node_modules\electron-builder\cli.js" --win portable --x64 --config.win.signAndEditExecutable=false
  Start-Process -FilePath $ExePath | Out-Null
} finally {
  Clear-MaintenanceLock
}
