param(
  [string]$ExePath = "C:\RouterFarm\dist\win-arm64-unpacked\RouterFarm.exe",
  [string]$ShortcutName = "RouterFarm"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "RouterFarm executable was not found at $ExePath"
}

$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\RouterFarm"
$shortcutPath = Join-Path $startMenuDir "$ShortcutName.lnk"

New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ExePath
$shortcut.WorkingDirectory = Split-Path -Parent $ExePath
$shortcut.IconLocation = "$ExePath,0"
$shortcut.Description = "RouterFarm desktop app"
$shortcut.Save()

[pscustomobject]@{
  ok = $true
  shortcutPath = $shortcutPath
  exePath = $ExePath
} | ConvertTo-Json -Compress
