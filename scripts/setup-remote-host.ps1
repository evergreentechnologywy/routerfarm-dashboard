param(
  [Parameter(Mandatory = $true)]
  [string]$RustDeskPassword,

  [string]$RustDeskConfigString = "",

  [string]$RustDeskId = "",

  [switch]$DisableHibernate = $true
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ("[setup] " + $Message)
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-RustDeskPath {
  $candidates = @(
    "C:\Program Files\RustDesk\rustdesk.exe",
    "C:\Program Files (x86)\RustDesk\rustdesk.exe",
    (Join-Path $env:LOCALAPPDATA "Programs\RustDesk\rustdesk.exe")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  $command = Get-Command rustdesk -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    return $command.Source
  }

  return $null
}

function Install-RustDesk {
  $winget = Get-Command winget -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $winget) {
    throw "winget is not available. Install RustDesk manually first."
  }

  $packageIds = @(
    "RustDesk.RustDesk"
  )

  foreach ($packageId in $packageIds) {
    Write-Step "Trying RustDesk install via winget package id $packageId"
    & $winget.Source install --id $packageId --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -eq 0) {
      return
    }
  }

  throw "RustDesk installation failed via winget."
}

function Invoke-RustDesk {
  param(
    [string]$RustDeskExe,
    [string[]]$Arguments
  )

  & $RustDeskExe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "RustDesk command failed: $($Arguments -join ' ')"
  }
}

function Try-Set-RustDeskPassword {
  param(
    [string]$RustDeskExe,
    [string]$Password
  )

  $attempts = @(
    @("--password", $Password),
    @("--set-password", $Password)
  )

  foreach ($attempt in $attempts) {
    try {
      & $RustDeskExe @attempt | Out-Null
      if ($LASTEXITCODE -eq 0) {
        return $true
      }
    }
    catch {
      # Try next known variant.
    }
  }

  return $false
}

function Ensure-StartupTask {
  param(
    [string]$RustDeskExe
  )

  $taskName = "PhoneFarm RustDesk AutoStart"
  $existing = schtasks /Query /TN $taskName 2>$null
  if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $taskName /F | Out-Null
  }

  $taskCommand = ('"{0}"' -f $RustDeskExe)
  schtasks /Create /TN $taskName /SC ONSTART /RL HIGHEST /TR $taskCommand /F | Out-Null
}

function Set-PowerProfile {
  Write-Step "Disabling monitor sleep on AC and DC"
  powercfg /X monitor-timeout-ac 0 | Out-Null
  powercfg /X monitor-timeout-dc 0 | Out-Null

  Write-Step "Disabling standby sleep on AC and DC"
  powercfg /X standby-timeout-ac 0 | Out-Null
  powercfg /X standby-timeout-dc 0 | Out-Null

  Write-Step "Disabling hibernate timeout on AC and DC"
  powercfg /X hibernate-timeout-ac 0 | Out-Null
  powercfg /X hibernate-timeout-dc 0 | Out-Null

  if ($DisableHibernate) {
    Write-Step "Turning off hibernation"
    powercfg /hibernate off | Out-Null
  }
}

function Set-SystemRecovery {
  Write-Step "Enabling automatic reboot after system crash"
  Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl" -Name AutoReboot -Value 1 -Type DWord
}

function Ensure-FirewallRule {
  param(
    [string]$DisplayName,
    [string]$ProgramPath
  )

  $existing = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
    Where-Object { $_.Program -eq $ProgramPath } |
    Select-Object -First 1

  if ($existing) {
    return
  }

  New-NetFirewallRule -DisplayName $DisplayName -Direction Inbound -Action Allow -Program $ProgramPath | Out-Null
}

if (-not (Test-Admin)) {
  throw "Run this script as Administrator."
}

Write-Step "Resolving RustDesk installation"
$rustDeskExe = Resolve-RustDeskPath
if (-not $rustDeskExe) {
  Install-RustDesk
  Start-Sleep -Seconds 3
  $rustDeskExe = Resolve-RustDeskPath
}

if (-not $rustDeskExe) {
  throw "RustDesk executable was not found after installation."
}

Write-Step ("Using RustDesk at " + $rustDeskExe)

if ($RustDeskConfigString) {
  Write-Step "Importing RustDesk server configuration"
  Invoke-RustDesk -RustDeskExe $rustDeskExe -Arguments @("--config", $RustDeskConfigString)
}

if ($RustDeskId) {
  Write-Step "Setting RustDesk ID"
  Invoke-RustDesk -RustDeskExe $rustDeskExe -Arguments @("--set-id", $RustDeskId)
}

Write-Step "Setting permanent RustDesk password"
$passwordSet = Try-Set-RustDeskPassword -RustDeskExe $rustDeskExe -Password $RustDeskPassword
if (-not $passwordSet) {
  Write-Warning "RustDesk password command was not confirmed on this build. Set the permanent password manually after launch if needed."
}

Write-Step "Creating startup task"
Ensure-StartupTask -RustDeskExe $rustDeskExe

Write-Step "Allowing RustDesk through Windows Firewall"
Ensure-FirewallRule -DisplayName "RustDesk Host" -ProgramPath $rustDeskExe

Write-Step "Applying no-sleep power policy"
Set-PowerProfile

Write-Step "Applying automatic reboot on crash"
Set-SystemRecovery

Write-Step "Launching RustDesk"
Start-Process -FilePath $rustDeskExe | Out-Null

Write-Host ""
Write-Host "RustDesk host setup completed."
Write-Host "Manual BIOS/UEFI action still required:"
Write-Host "  Set 'Restore on AC Power Loss' or equivalent to 'Power On'."
