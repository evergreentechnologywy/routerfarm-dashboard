param(
  [Parameter(Mandatory = $true)]
  [string]$Username,
  [Parameter(Mandatory = $true)]
  [string]$Password,
  [string]$DisplayName = "",
  [string[]]$AllowedDevices = @(),
  [ValidateSet("admin", "operator")]
  [string]$Role = "operator"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$usersPath = Join-Path $root "config\users.json"

function New-PasswordHash {
  param([string]$PlainTextPassword)
  $iterations = 210000
  $saltBytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($saltBytes)
  $salt = [Convert]::ToHexString($saltBytes).ToLowerInvariant()
  $derive = [System.Security.Cryptography.Rfc2898DeriveBytes]::new($PlainTextPassword, [Convert]::FromHexString($salt), $iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  $hash = [Convert]::ToHexString($derive.GetBytes(32)).ToLowerInvariant()
  return "pbkdf2`$$iterations`$$salt`$$hash"
}

if (-not (Test-Path $usersPath)) {
  throw "users.json not found at $usersPath"
}

$config = Get-Content -Raw -Path $usersPath | ConvertFrom-Json
if (-not $config.users) {
  $config | Add-Member -NotePropertyName users -NotePropertyValue @()
}

$normalizedAllowedDevices = if ($Role -eq "admin") { @("*") } else { $AllowedDevices | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() } }
$existing = $config.users | Where-Object { $_.username -eq $Username } | Select-Object -First 1
$hash = New-PasswordHash -PlainTextPassword $Password
$effectiveDisplayName = if ($DisplayName) { $DisplayName } else { $Username }

if ($existing) {
  $existing.displayName = $effectiveDisplayName
  $existing.role = $Role
  $existing.allowedDevices = $normalizedAllowedDevices
  $existing.passwordHash = $hash
  Write-Output "Updated user $Username"
} else {
  $newUser = [pscustomobject]@{
    username = $Username
    displayName = $effectiveDisplayName
    role = $Role
    allowedDevices = $normalizedAllowedDevices
    passwordHash = $hash
  }
  $config.users = @($config.users) + $newUser
  Write-Output "Created user $Username"
}

$config | ConvertTo-Json -Depth 8 | Set-Content -Path $usersPath
Write-Output "Saved $usersPath"
