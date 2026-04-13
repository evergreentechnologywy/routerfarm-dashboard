param(
  [Parameter(Mandatory = $true)]
  [string]$RouterId,

  [int]$PowerCycleSeconds = 12
)

$payload = @{
  ok = $false
  routerId = $RouterId
  action = "cycle-mobile-uplink"
  message = "Power cycle wiring is not configured yet. Attach a controllable USB relay or smart outlet command before using this action."
  recommendedDelaySeconds = $PowerCycleSeconds
  checkedAt = [DateTime]::UtcNow.ToString("o")
}

$payload | ConvertTo-Json -Depth 6 -Compress
exit 1
