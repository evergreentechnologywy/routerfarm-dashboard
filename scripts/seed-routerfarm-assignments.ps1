param(
  [string]$DevicesPath = "C:\RouterFarm\config\devices.json",
  [string]$RoutersPath = "C:\RouterFarm\config\routers.json",
  [switch]$PreserveExistingAssignments
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $DevicesPath)) {
  throw "Devices config not found: $DevicesPath"
}

if (-not (Test-Path -LiteralPath $RoutersPath)) {
  throw "Routers config not found: $RoutersPath"
}

$devicesConfig = Get-Content -LiteralPath $DevicesPath -Raw | ConvertFrom-Json
$routersConfig = Get-Content -LiteralPath $RoutersPath -Raw | ConvertFrom-Json

$routers = @($routersConfig.routers) | Where-Object { $_.enabled -ne $false } | Sort-Object label, id
if (-not $routers.Count) {
  throw "No enabled routers found in $RoutersPath"
}

$slotMap = @{}
foreach ($router in $routers) {
  $slotMap[$router.id] = New-Object System.Collections.Generic.List[object]
}

$devices = @($devicesConfig.devices)
foreach ($device in $devices) {
  if (-not ($device.PSObject.Properties.Name -contains "routerId")) {
    $device | Add-Member -NotePropertyName routerId -NotePropertyValue ""
  }
  if (-not ($device.PSObject.Properties.Name -contains "routerSlot")) {
    $device | Add-Member -NotePropertyName routerSlot -NotePropertyValue $null
  }
  $device.role = "router-client"
  if ($PreserveExistingAssignments -and $device.routerId) {
    if ($slotMap.ContainsKey($device.routerId)) {
      $slotMap[$device.routerId].Add($device) | Out-Null
    }
  } else {
    $device.routerId = ""
    $device.routerSlot = $null
  }
}

$unassigned = @($devices | Where-Object { -not $_.routerId })
$routerIndex = 0

foreach ($device in $unassigned) {
  $assigned = $false
  for ($offset = 0; $offset -lt $routers.Count; $offset += 1) {
    $candidate = $routers[($routerIndex + $offset) % $routers.Count]
    $maxAssigned = if ($candidate.maxAssignedDevices) { [int]$candidate.maxAssignedDevices } else { 4 }
    if ($slotMap[$candidate.id].Count -lt $maxAssigned) {
      $usedSlots = @($slotMap[$candidate.id] | ForEach-Object { [int]($_.routerSlot) } | Where-Object { $_ -gt 0 })
      $slot = 1
      while ($usedSlots -contains $slot) {
        $slot += 1
      }
      $device.routerId = $candidate.id
      $device.routerSlot = $slot
      $slotMap[$candidate.id].Add($device) | Out-Null
      $routerIndex = (($routerIndex + $offset) % $routers.Count) + 1
      $assigned = $true
      break
    }
  }

  if (-not $assigned) {
    throw "Not enough router capacity for all devices. Increase router count or maxAssignedDevices."
  }
}

$devicesConfig.devices = $devices
$devicesConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $DevicesPath -Encoding UTF8

[PSCustomObject]@{
  ok = $true
  routers = $routers.Count
  devices = $devices.Count
  assigned = @($devices | Where-Object { $_.routerId }).Count
  preservedExistingAssignments = [bool]$PreserveExistingAssignments
} | ConvertTo-Json -Depth 6 -Compress
