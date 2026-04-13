param(
  [switch]$StartAfterInstall = $true
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$settingsPath = Join-Path $root "config\settings.json"

function Write-Step {
  param([string]$Message)
  Write-Host "[RouterFarm] $Message"
}

function Assert-Command {
  param(
    [string]$Name,
    [string]$WingetId
  )

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Step "$Name already available at $($cmd.Source)"
    return $cmd.Source
  }

  Write-Step "Installing $Name via winget package $WingetId"
  winget install --id $WingetId --exact --accept-package-agreements --accept-source-agreements | Out-Host
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Step "$Name installed at $($cmd.Source)"
    return $cmd.Source
  }

  return $null
}

function Resolve-WinGetPackageBinary {
  param(
    [string]$PackageDirGlob,
    [string]$RelativeBinaryPath
  )

  $packageRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  $packageDir = Get-ChildItem -Path $packageRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like $PackageDirGlob } |
    Select-Object -First 1

  if (-not $packageDir) {
    return $null
  }

  $binaryPath = Join-Path $packageDir.FullName $RelativeBinaryPath
  if (Test-Path $binaryPath) {
    return $binaryPath
  }

  return $null
}

function Update-SettingsPaths {
  param(
    [string]$AdbPath,
    [string]$ScrcpyPath
  )

  if (-not (Test-Path $settingsPath)) {
    throw "Settings file not found at $settingsPath"
  }

  $settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  if ($AdbPath) {
    $settings.adbPath = $AdbPath
  }
  if ($ScrcpyPath) {
    $settings.scrcpyPath = $ScrcpyPath
  }

  $settings | ConvertTo-Json -Depth 8 | Set-Content -Path $settingsPath
  Write-Step "Updated settings.json tool paths"
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is required on this machine. Install App Installer from Microsoft first."
}

$nodePath = Assert-Command -Name "node" -WingetId "OpenJS.NodeJS.LTS"
$adbPath = Assert-Command -Name "adb" -WingetId "Google.PlatformTools"
$scrcpyPath = Assert-Command -Name "scrcpy" -WingetId "Genymobile.scrcpy"

if (-not $adbPath) {
  $adbPath = Resolve-WinGetPackageBinary -PackageDirGlob "Google.PlatformTools*" -RelativeBinaryPath "platform-tools\adb.exe"
}

if (-not $scrcpyPath) {
  $scrcpyPath = Resolve-WinGetPackageBinary -PackageDirGlob "Genymobile.scrcpy*" -RelativeBinaryPath "scrcpy-win64-v*\scrcpy.exe"
  if (-not $scrcpyPath) {
    $scrcpyPackageRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    $scrcpyPath = Get-ChildItem -Path $scrcpyPackageRoot -Recurse -Filter "scrcpy.exe" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like "*Genymobile.scrcpy*" } |
      Select-Object -ExpandProperty FullName -First 1
  }
}

if (-not $adbPath) {
  throw "adb.exe was not found after installation."
}

if (-not $scrcpyPath) {
  throw "scrcpy.exe was not found after installation."
}

Update-SettingsPaths -AdbPath $adbPath -ScrcpyPath $scrcpyPath

Write-Step "Running healthcheck"
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\healthcheck-routerfarm.ps1")

if ($StartAfterInstall) {
  Write-Step "Starting RouterFarm"
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "start-routerfarm.ps1")
}

Write-Step "Deployment bootstrap completed"
