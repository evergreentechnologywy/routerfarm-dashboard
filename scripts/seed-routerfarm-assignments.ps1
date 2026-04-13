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

$sourceDevices = @($devicesConfig.devices)
$assignmentPool = @{}
foreach ($router in $routers) {
  $assignmentPool[$router.id] = New-Object System.Collections.Generic.List[object]
}

$normalizedDevices = foreach ($sourceDevice in $sourceDevices) {
  $device = [ordered]@{
    serial = [string]$sourceDevice.serial
    phoneNumber = if ($null -ne $sourceDevice.phoneNumber -and [int]$sourceDevice.phoneNumber -gt 0) { [int]$sourceDevice.phoneNumber } else { $null }
    nickname = [string]$sourceDevice.nickname
    role = "router-client"
    parentHotspotSerial = [string]$sourceDevice.parentHotspotSerial
    routerId = ""
    routerSlot = $null
  }

  $existingRouterId = [string]$sourceDevice.routerId
  $existingRouterSlot = if ($null -ne $sourceDevice.routerSlot -and [int]$sourceDevice.routerSlot -gt 0) { [int]$sourceDevice.routerSlot } else { $null }
  if ($PreserveExistingAssignments -and $existingRouterId -and $assignmentPool.ContainsKey($existingRouterId)) {
    $device.routerId = $existingRouterId
    $device.routerSlot = $existingRouterSlot
    $assignmentPool[$existingRouterId].Add([pscustomobject]$device) | Out-Null
  }

  [pscustomobject]$device
}

$unassigned = @($normalizedDevices | Where-Object { -not $_.routerId })
$routerIndex = 0

foreach ($device in $unassigned) {
  $assigned = $false
  for ($offset = 0; $offset -lt $routers.Count; $offset += 1) {
    $candidate = $routers[($routerIndex + $offset) % $routers.Count]
    $maxAssigned = if ($candidate.maxAssignedDevices) { [int]$candidate.maxAssignedDevices } else { 4 }
    $bucket = $assignmentPool[$candidate.id]
    if ($bucket.Count -ge $maxAssigned) {
      continue
    }

    $usedSlots = @($bucket | ForEach-Object { [int]$_.routerSlot } | Where-Object { $_ -gt 0 })
    $slot = 1
    while ($usedSlots -contains $slot) {
      $slot += 1
    }

    $device.routerId = $candidate.id
    $device.routerSlot = $slot
    $bucket.Add($device) | Out-Null
    $routerIndex = (($routerIndex + $offset) % $routers.Count) + 1
    $assigned = $true
    break
  }

  if (-not $assigned) {
    throw "Not enough router capacity for all devices. Increase router count or maxAssignedDevices."
  }
}

$outputConfig = [ordered]@{
  devices = @($normalizedDevices)
}
($outputConfig | ConvertTo-Json -Depth 8) + "`n" | Set-Content -LiteralPath $DevicesPath -Encoding UTF8

[pscustomobject]@{
  ok = $true
  routers = $routers.Count
  devices = $normalizedDevices.Count
  assigned = @($normalizedDevices | Where-Object { $_.routerId }).Count
  preservedExistingAssignments = [bool]$PreserveExistingAssignments
} | ConvertTo-Json -Depth 6 -Compress
