param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,

  [int]$ViewerPid = 0
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$activityLogPath = Join-Path $root "logs\\activity.log"

function Write-ActivityLog {
  param(
    [string]$Category,
    [string]$Message,
    [string]$DeviceSerial = ""
  )

  $timestamp = (Get-Date).ToString("o")
  $serialSegment = if ($DeviceSerial) { " [$DeviceSerial]" } else { "" }
  Add-Content -Path $activityLogPath -Value "[$timestamp] [$Category]$serialSegment $Message"
}

if ($ViewerPid -gt 0) {
  $directProcess = Get-Process -Id $ViewerPid -ErrorAction SilentlyContinue
  if ($directProcess) {
    Stop-Process -Id $directProcess.Id -Force
    Write-ActivityLog -Category "scrcpy" -Message ("Stopped scrcpy process " + $directProcess.Id + " from recorded PID") -DeviceSerial $Serial
    exit 0
  }
}

$windowTitle = "RouterFarm-$Serial"
$candidates = @(Get-Process -Name "scrcpy" -ErrorAction SilentlyContinue | Where-Object {
  try {
    $_.MainWindowTitle -eq $windowTitle
  }
  catch {
    $false
  }
})

if (-not $candidates) {
  Write-ActivityLog -Category "scrcpy" -Message "No scrcpy process found to stop" -DeviceSerial $Serial
  exit 0
}

foreach ($process in $candidates) {
  Stop-Process -Id $process.Id -Force
  Write-ActivityLog -Category "scrcpy" -Message ("Stopped scrcpy process " + $process.Id) -DeviceSerial $Serial
}

exit 0
