param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

function Test-ScriptSet {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BasePath,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if (-not (Test-Path $BasePath)) {
    return @()
  }

  $failures = @()
  $files = Get-ChildItem -Path $BasePath -Filter *.ps1 -File | Sort-Object Name
  foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    foreach ($error in @($errors)) {
      $failures += [pscustomobject]@{
        Scope = $Label
        File = $file.Name
        Path = $file.FullName
        Line = $error.Extent.StartLineNumber
        Column = $error.Extent.StartColumnNumber
        Message = $error.Message
      }
    }
  }

  return $failures
}

$failures = @()
$failures += Test-ScriptSet -BasePath (Join-Path $root "scripts") -Label "source"
$failures += Test-ScriptSet -BasePath (Join-Path $root "dist\\win-unpacked\\resources\\app\\scripts") -Label "dist"

if ($failures.Count -gt 0) {
  $failures | Sort-Object Scope, File, Line, Column | Format-Table -AutoSize
  throw "Windows PowerShell compatibility check failed for $($failures.Count) parse error(s)."
}

Write-Host "Windows PowerShell compatibility check passed."
