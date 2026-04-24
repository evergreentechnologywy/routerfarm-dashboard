param(
  [Parameter(Mandatory = $true)]
  [string]$Serial
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\\settings.json"
$activityLogPath = Join-Path $root "logs\\activity.log"

function Write-ActivityLog {
  param(
    [string]$Category,
    [string]$Message,
    [string]$DeviceSerial = ""
  )

  $timestamp = (Get-Date).ToString("o")
  $serialSegment = if ($DeviceSerial) { " [$DeviceSerial]" } else { "" }
  $line = "[$timestamp] [$Category]$serialSegment $Message"
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    try {
      Add-Content -Path $activityLogPath -Value $line -ErrorAction Stop
      return
    }
    catch {
      if ($attempt -eq 3) {
        return
      }
      Start-Sleep -Milliseconds (100 * $attempt)
    }
  }
}

function Get-Settings {
  if (Test-Path $settingsPath) {
    return Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{
    adbPath = "adb"
    scrcpyPath = "scrcpy"
    vysorPath = ""
  }
}

function Resolve-ToolPath {
  param(
    [string]$ConfiguredPath,
    [string]$FallbackName
  )

  if ($ConfiguredPath -and (Test-Path -LiteralPath $ConfiguredPath)) {
    return $ConfiguredPath
  }

  $command = Get-Command $FallbackName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    return $command.Source
  }

  if ($ConfiguredPath) {
    return $ConfiguredPath
  }

  return $FallbackName
}

function Get-DeviceState {
  param(
    [string]$AdbPath,
    [string]$DeviceSerial
  )

  $output = & $AdbPath -s $DeviceSerial get-state 2>&1
  return [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Output = [string]::Join([Environment]::NewLine, $output)
  }
}

function Get-ScrcpyProcesses {
  param(
    [string]$ExpectedPath
  )

  $processes = @(Get-Process -Name "scrcpy" -ErrorAction SilentlyContinue)
  if (-not $ExpectedPath) {
    return $processes
  }

  return @($processes | Where-Object {
    try {
      $_.Path -eq $ExpectedPath
    }
    catch {
      $false
    }
  })
}

function Get-ScrcpyProcessSnapshot {
  param(
    [string]$ExpectedPath,
    [string]$DeviceSerial,
    [string]$ExpectedWindowTitle
  )

  $cimProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'scrcpy.exe'" -ErrorAction SilentlyContinue)
  $processMap = @{}
  foreach ($process in @(Get-ScrcpyProcesses -ExpectedPath $ExpectedPath)) {
    $processMap[[string]$process.Id] = $process
  }

  $snapshots = @()
  foreach ($cimProcess in $cimProcesses) {
    $commandLine = [string]$cimProcess.CommandLine
    $pathOk = -not $ExpectedPath -or ([string]$cimProcess.ExecutablePath -eq $ExpectedPath)
    $serialMatch = $commandLine -match [regex]::Escape($DeviceSerial)
    $titleMatch = $commandLine -match [regex]::Escape($ExpectedWindowTitle)
    if (-not $pathOk -or (-not $serialMatch -and -not $titleMatch)) {
      continue
    }

    $liveProcess = $processMap[[string]$cimProcess.ProcessId]
    if (-not $liveProcess) {
      try {
        $liveProcess = Get-Process -Id $cimProcess.ProcessId -ErrorAction Stop
      }
      catch {
        $liveProcess = $null
      }
    }

    if ($liveProcess) {
      $resolvedPath = if ($ExpectedPath) { $ExpectedPath } else { [string]$cimProcess.ExecutablePath }
      $snapshots += [pscustomobject]@{
        Id = $liveProcess.Id
        ProcessName = $liveProcess.ProcessName
        Path = $resolvedPath
        CommandLine = $commandLine
        MainWindowHandle = [int64]$liveProcess.MainWindowHandle
        MainWindowTitle = [string]$liveProcess.MainWindowTitle
      }
    }
  }

  return @($snapshots | Sort-Object Id -Unique)
}

$settings = Get-Settings
$adbPath = Resolve-ToolPath -ConfiguredPath $settings.adbPath -FallbackName "adb"
$scrcpyPath = Resolve-ToolPath -ConfiguredPath $settings.scrcpyPath -FallbackName "scrcpy"
$defaultVysorPath = Join-Path $env:LOCALAPPDATA "vysor\\Vysor.exe"
$vysorPath = if ($settings.vysorPath) { $settings.vysorPath } elseif (Test-Path -LiteralPath $defaultVysorPath) { $defaultVysorPath } else { "" }
$workingDirectory = Split-Path -Parent $scrcpyPath
$windowTitle = "RouterFarm-$Serial"

try {
  if (-not (Test-Path -LiteralPath $scrcpyPath)) {
    throw "scrcpy executable was not found at $scrcpyPath"
  }

  $deviceState = Get-DeviceState -AdbPath $adbPath -DeviceSerial $Serial
  if ($deviceState.ExitCode -ne 0 -or $deviceState.Output.Trim() -ne "device") {
    throw "ADB did not report the target device as ready. State=$($deviceState.Output.Trim())"
  }

  $launchArgs = @("--serial=$Serial", "--no-audio", "--window-title=$windowTitle")
  $result = $null

  for ($attempt = 1; $attempt -le 2; $attempt += 1) {
    $beforeIds = @((Get-ScrcpyProcesses -ExpectedPath $scrcpyPath | ForEach-Object { $_.Id }))
    Write-ActivityLog -Category "scrcpy" -Message ("Launching scrcpy attempt $attempt via " + $scrcpyPath) -DeviceSerial $Serial
    $startedProcess = Start-Process -FilePath $scrcpyPath -WorkingDirectory $workingDirectory -ArgumentList $launchArgs -PassThru
    $startedPid = if ($startedProcess) { $startedProcess.Id } else { 0 }

    $deadline = (Get-Date).AddSeconds(12)
    do {
      Start-Sleep -Milliseconds 350
      $candidates = @()

      if ($startedPid -gt 0) {
        try {
          $directProcess = Get-Process -Id $startedPid -ErrorAction Stop
          $candidates += [pscustomobject]@{
            Id = $directProcess.Id
            ProcessName = $directProcess.ProcessName
            Path = $scrcpyPath
            CommandLine = ""
            MainWindowHandle = [int64]$directProcess.MainWindowHandle
            MainWindowTitle = [string]$directProcess.MainWindowTitle
          }
        }
        catch {
          # The direct process may exit quickly; fall back to serial-specific discovery below.
        }
      }

      $candidates += @(Get-ScrcpyProcessSnapshot -ExpectedPath $scrcpyPath -DeviceSerial $Serial -ExpectedWindowTitle $windowTitle | Where-Object { $_.Id -notin $beforeIds })
      $candidates = @($candidates | Sort-Object Id -Unique)
      foreach ($candidate in $candidates) {
        $matchedBy = if ($candidate.CommandLine) { "command-line" } elseif ($candidate.Id -eq $startedPid) { "started-pid" } else { "process-scan" }
        $candidateResult = [pscustomobject]@{
          ok = $true
          serial = $Serial
          pid = $candidate.Id
          processName = $candidate.ProcessName
          filePath = $candidate.Path
          startedAt = (Get-Date).ToString("o")
          aliveAfterLaunch = $true
          mainWindowHandle = [int64]$candidate.MainWindowHandle
          mainWindowTitle = [string]$candidate.MainWindowTitle
          windowReady = [bool]($candidate.MainWindowHandle -ne 0)
          attempt = $attempt
          matchedBy = $matchedBy
        }

        $result = $candidateResult

        if ($candidateResult.windowReady -or ((Get-Date) -ge $deadline) -or $attempt -eq 2) {
          break
        }
      }
    } while ((Get-Date) -lt $deadline -and -not $result)

    if ($result) {
      break
    }

    Write-ActivityLog -Category "scrcpy" -Message ("scrcpy attempt $attempt did not produce a detectable per-device process") -DeviceSerial $Serial
    Start-Sleep -Milliseconds 600
  }

  if (-not $result) {
    $scrcpyFailure = "scrcpy did not create a detectable viewer process for this serial."
    if ($vysorPath -and (Test-Path -LiteralPath $vysorPath)) {
      $vysorBeforeIds = @((Get-Process -Name "Vysor" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }))
      Write-ActivityLog -Category "scrcpy" -Message ("scrcpy failed; launching Vysor fallback via " + $vysorPath) -DeviceSerial $Serial
      Start-Process -FilePath $vysorPath | Out-Null

      $vysorDeadline = (Get-Date).AddSeconds(8)
      do {
        Start-Sleep -Milliseconds 350
        $vysorProcess = @(Get-Process -Name "Vysor" -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $vysorBeforeIds }) | Select-Object -First 1
        if ($vysorProcess) {
          $fallbackPayload = [pscustomobject]@{
            ok = $true
            serial = $Serial
            pid = $vysorProcess.Id
            processName = $vysorProcess.ProcessName
            filePath = $vysorPath
            startedAt = (Get-Date).ToString("o")
            aliveAfterLaunch = $true
            mainWindowHandle = [int64]$vysorProcess.MainWindowHandle
            mainWindowTitle = [string]$vysorProcess.MainWindowTitle
            windowReady = [bool]($vysorProcess.MainWindowHandle -ne 0)
            fallbackViewer = "vysor"
            manualSelectionRequired = $true
            scrcpyError = $scrcpyFailure
          }
          Write-ActivityLog -Category "scrcpy" -Message ("Vysor fallback launched with PID " + $vysorProcess.Id) -DeviceSerial $Serial
          $fallbackPayload | ConvertTo-Json -Compress
          exit 0
        }
      } while ((Get-Date) -lt $vysorDeadline)
    }

    throw $scrcpyFailure
  }

  Write-ActivityLog -Category "scrcpy" -Message ("scrcpy detected with PID " + $result.pid + "; windowReady=" + $result.windowReady + "; attempt=" + $result.attempt + "; matchedBy=" + $result.matchedBy) -DeviceSerial $Serial
  $result | ConvertTo-Json -Compress
  exit 0
}
catch {
  $lineNumber = $_.InvocationInfo.ScriptLineNumber
  $message = if ($lineNumber) { "$($_.Exception.Message) (line $lineNumber)" } else { $_.Exception.Message }
  Write-ActivityLog -Category "scrcpy" -Message ("scrcpy launch failed: " + $message) -DeviceSerial $Serial
  [pscustomobject]@{
    ok = $false
    serial = $Serial
    error = $message
    filePath = $scrcpyPath
    startedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Compress
  exit 1
}
