param(
  [string]$ExePath,
  [string]$ShortcutName = "RouterFarm",
  [switch]$Desktop
)

$ErrorActionPreference = "Stop"

if (-not $ExePath) {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $candidatePaths = @(
    (Join-Path $projectRoot "dist\win-unpacked\RouterFarm.exe"),
    (Join-Path $projectRoot "dist\win-arm64-unpacked\RouterFarm.exe"),
    "C:\RouterFarm\dist\win-unpacked\RouterFarm.exe",
    "C:\RouterFarm\dist\win-arm64-unpacked\RouterFarm.exe"
  )
  $ExePath = $candidatePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "RouterFarm executable was not found at $ExePath"
}

$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\RouterFarm"
$desktopDir = [Environment]::GetFolderPath("Desktop")
$shortcutTargets = @(
  (Join-Path $startMenuDir "$ShortcutName.lnk")
)

if ($Desktop) {
  $shortcutTargets += (Join-Path $desktopDir "$ShortcutName.lnk")
}

New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in $shortcutTargets) {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $ExePath
  $shortcut.WorkingDirectory = Split-Path -Parent $ExePath
  $shortcut.IconLocation = "$ExePath,0"
  $shortcut.Description = "RouterFarm desktop app"
  $shortcut.Save()
}

[pscustomobject]@{
  ok = $true
  shortcutPaths = $shortcutTargets
  exePath = $ExePath
} | ConvertTo-Json -Compress
