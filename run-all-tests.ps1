# run-all-tests.ps1
# Runs all binary test apps and writes a consolidated markdown report.
# Keeps run-limit-test.ps1 as standalone utility.

param(
  [string]$ServerUrl = "https://mea-sama.duckdns.org:12346",
  [int]$LoadHz = 120,
  [int]$LoadDurationSec = 10
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$resultsRoot = Join-Path $root 'test/results'
$suiteDir = Join-Path $resultsRoot ("suite-" + $timestamp)
New-Item -ItemType Directory -Path $suiteDir -Force | Out-Null

function Write-Title([string]$text) {
  Write-Host ""
  Write-Host "==== $text ===="
}

function Invoke-TestProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Slug,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$SuccessPattern = 'SUCCESS:'
  )

  $stdoutPath = Join-Path $suiteDir ("$Slug.stdout.log")
  $stderrPath = Join-Path $suiteDir ("$Slug.stderr.log")

  $resolvedFilePath = $FilePath
  if ($FilePath -ieq 'npx') {
    $resolvedFilePath = 'npx.cmd'
  }

  Write-Title $Name
  Write-Host ("Command: {0} {1}" -f $resolvedFilePath, ($Arguments -join ' '))

  $proc = Start-Process -FilePath $resolvedFilePath -ArgumentList $Arguments -NoNewWindow -PassThru -Wait -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

  $stdout = ''
  if (Test-Path $stdoutPath) { $stdout = [string](Get-Content -Raw -Path $stdoutPath) }
  $stderr = ''
  if (Test-Path $stderrPath) { $stderr = [string](Get-Content -Raw -Path $stderrPath) }
  $combined = ($stdout + "`n" + $stderr)

  if (-not [string]::IsNullOrWhiteSpace($stdout)) {
    Write-Host '--- stdout ---'
    Write-Host $stdout
  }
  if (-not [string]::IsNullOrWhiteSpace($stderr)) {
    Write-Host '--- stderr ---'
    Write-Host $stderr
  }

  $successMatch = $true
  if ($SuccessPattern -and $SuccessPattern.Trim().Length -gt 0) {
    $successMatch = $combined -match [Regex]::Escape($SuccessPattern)
  }

  $resultJson = $null
  $resultMatch = [Regex]::Match($combined, 'Result file:\s*(.+)')
  if ($resultMatch.Success) {
    $candidate = $resultMatch.Groups[1].Value.Trim()
    if (Test-Path $candidate) {
      $resultJson = $candidate
    }
  }

  $passLines = @([Regex]::Matches($combined, '(?m)^PASS:\s+(.+)$') | ForEach-Object { $_.Groups[1].Value.Trim() })
  $passed = ($proc.ExitCode -eq 0) -and $successMatch

  [PSCustomObject]@{
    Name = $Name
    Slug = $Slug
    Command = "$resolvedFilePath $($Arguments -join ' ')"
    ExitCode = $proc.ExitCode
    Passed = $passed
    SuccessPattern = $SuccessPattern
    SuccessPatternFound = $successMatch
    StdoutLog = $stdoutPath
    StderrLog = $stderrPath
    ResultJson = $resultJson
    PassLines = $passLines
  }
}

function Invoke-CrossInteropTest {
  param(
    [Parameter(Mandatory = $true)][string]$Server,
    [Parameter(Mandatory = $true)][string]$RunId
  )

  Write-Title 'Binary cross interop (Node <-> C#)'

  $guestSlug = 'binary-cross-guest'
  $hostSlug = 'binary-cross-host'

  $guestOut = Join-Path $suiteDir ("$guestSlug.stdout.log")
  $guestErr = Join-Path $suiteDir ("$guestSlug.stderr.log")

  $guestArgs = @(
    'run',
    '--project',
    'test/binary-cross-app/csharp-guest/BinaryCrossGuest.csproj',
    '--',
    $Server,
    $RunId
  )

  Write-Host ("Starting guest: dotnet {0}" -f ($guestArgs -join ' '))
  $guestProc = Start-Process -FilePath 'dotnet' -ArgumentList $guestArgs -NoNewWindow -PassThru -RedirectStandardOutput $guestOut -RedirectStandardError $guestErr

  [System.Threading.Thread]::Sleep(1200)

  $hostResult = Invoke-TestProcess -Name 'Binary cross host (Node side)' -Slug $hostSlug -FilePath 'npx' -Arguments @(
    'ts-node',
    '--project',
    'test/tsconfig.json',
    'test/binary-cross-app/host-node.ts',
    $Server,
    $RunId
  ) -SuccessPattern 'SUCCESS: Cross interop host flow complete'

  $guestTimedOut = -not $guestProc.WaitForExit(90000)
  if ($guestTimedOut) {
    try { $guestProc.Kill($true) } catch { }
  }

  $guestStdout = ''
  if (Test-Path $guestOut) { $guestStdout = [string](Get-Content -Raw -Path $guestOut) }
  $guestStderr = ''
  if (Test-Path $guestErr) { $guestStderr = [string](Get-Content -Raw -Path $guestErr) }
  $guestCombined = ($guestStdout + "`n" + $guestStderr)

  if (-not [string]::IsNullOrWhiteSpace($guestStdout)) {
    Write-Host '--- guest stdout ---'
    Write-Host $guestStdout
  }
  if (-not [string]::IsNullOrWhiteSpace($guestStderr)) {
    Write-Host '--- guest stderr ---'
    Write-Host $guestStderr
  }

  $guestExit = if ($guestTimedOut) { 124 } else {
    try { $guestProc.Refresh() } catch { }
    $guestProc.ExitCode
  }
  $guestSuccess = ($guestCombined -match [Regex]::Escape('SUCCESS: Cross interop guest flow complete'))
  if (($null -eq $guestExit) -and (-not $guestTimedOut) -and $guestSuccess) {
    $guestExit = 0
  }
  $guestPassLines = @([Regex]::Matches($guestCombined, '(?m)^PASS:\s+(.+)$') | ForEach-Object { $_.Groups[1].Value.Trim() })

  $guestResult = [PSCustomObject]@{
    Name = 'Binary cross guest (C# side)'
    Slug = $guestSlug
    Command = "dotnet $($guestArgs -join ' ')"
    ExitCode = $guestExit
    Passed = ($guestExit -eq 0) -and $guestSuccess
    SuccessPattern = 'SUCCESS: Cross interop guest flow complete'
    SuccessPatternFound = $guestSuccess
    StdoutLog = $guestOut
    StderrLog = $guestErr
    ResultJson = $null
    PassLines = $guestPassLines
  }

  return @($hostResult, $guestResult)
}

function Escape-Pipe([string]$value) {
  if ($null -eq $value) { return '' }
  return ($value -replace '\|', '\|')
}

function To-Relative([string]$pathValue) {
  if ([string]::IsNullOrWhiteSpace($pathValue)) { return '' }
  $fullRoot = [System.IO.Path]::GetFullPath($root)
  $fullPath = [System.IO.Path]::GetFullPath($pathValue)
  if ($fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath.Substring($fullRoot.Length).TrimStart([char[]]@(92, 47)) -replace '\\', '/'
  }
  return $pathValue -replace '\\', '/'
}

$testResults = New-Object System.Collections.Generic.List[object]

$testResults.Add((Invoke-TestProcess -Name 'Binary Node <-> Node' -Slug 'binary-node' -FilePath 'npx' -Arguments @(
  'ts-node',
  '--project',
  'test/tsconfig.json',
  'test/binary-node-app/app.ts',
  $ServerUrl
) -SuccessPattern 'SUCCESS: Node binary relay test completed'))

$testResults.Add((Invoke-TestProcess -Name 'Binary C# <-> C#' -Slug 'binary-csharp' -FilePath 'dotnet' -Arguments @(
  'run',
  '--project',
  'test/binary-csharp-app/BinaryCsharpApp.csproj',
  '--',
  $ServerUrl
) -SuccessPattern 'SUCCESS: C# binary relay test completed'))

$crossRunId = "suite-$timestamp"
$crossParts = Invoke-CrossInteropTest -Server $ServerUrl -RunId $crossRunId
foreach ($part in $crossParts) { $testResults.Add($part) }

$testResults.Add((Invoke-TestProcess -Name 'Binary load test' -Slug 'binary-load' -FilePath 'npx' -Arguments @(
  'ts-node',
  '--project',
  'test/tsconfig.json',
  'test/binary-load-app/app.ts',
  $ServerUrl,
  $LoadHz,
  $LoadDurationSec
) -SuccessPattern '=== LOAD TEST SUMMARY ==='))

$testResults.Add((Invoke-TestProcess -Name 'Binary limit test' -Slug 'binary-limit' -FilePath 'npx' -Arguments @(
  'ts-node',
  '--project',
  'test/tsconfig.json',
  'test/binary-limit-app/app.ts',
  $ServerUrl
) -SuccessPattern '=== LIMIT TEST SUMMARY ==='))

$summaryPath = Join-Path $suiteDir 'suite-summary.json'
$testResults | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding UTF8

$reportPath = Join-Path $suiteDir 'suite-report.md'
$md = New-Object System.Collections.Generic.List[string]

$md.Add('# Binary Test Suite Report')
$md.Add('')
$md.Add("- Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
$md.Add("- Server: $ServerUrl")
$md.Add("- Load test: ${LoadHz}Hz for ${LoadDurationSec}s per size")
$md.Add("- Suite dir: $(To-Relative $suiteDir)")
$md.Add('')

$overallPass = ($testResults | Where-Object { -not $_.Passed }).Count -eq 0
$md.Add("Overall result: **$(if ($overallPass) { 'PASS' } else { 'FAIL' })**")
$md.Add('')

$md.Add('## Test Overview')
$md.Add('')
$md.Add('| Test | Status | Exit | Result JSON | Stdout | Stderr |')
$md.Add('|---|---|---:|---|---|---|')
foreach ($r in $testResults) {
  $status = if ($r.Passed) { 'PASS' } else { 'FAIL' }
  $jsonRel = if ($r.ResultJson) { To-Relative $r.ResultJson } else { '' }
  $stdoutRel = To-Relative $r.StdoutLog
  $stderrRel = To-Relative $r.StderrLog
  $md.Add("| $(Escape-Pipe $r.Name) | $status | $($r.ExitCode) | $(Escape-Pipe $jsonRel) | $(Escape-Pipe $stdoutRel) | $(Escape-Pipe $stderrRel) |")
}
$md.Add('')

foreach ($r in $testResults) {
  $md.Add(("## {0}" -f $r.Name))
  $md.Add('')
  $md.Add('| Field | Value |')
  $md.Add('|---|---|')
  $detailStatus = if ($r.Passed) { 'PASS' } else { 'FAIL' }
  $md.Add(("| Status | {0} |" -f $detailStatus))
  $md.Add(("| Exit code | {0} |" -f $r.ExitCode))
  $md.Add(("| Success pattern found | {0} |" -f $r.SuccessPatternFound))
  $md.Add(("| Stdout log | {0} |" -f (To-Relative $r.StdoutLog)))
  $md.Add(("| Stderr log | {0} |" -f (To-Relative $r.StderrLog)))
  if ($r.ResultJson) {
    $md.Add(("| Result json | {0} |" -f (To-Relative $r.ResultJson)))
  }
  $md.Add('')

  $cases = @()
  if ($r.PassLines -and $r.PassLines.Count -gt 0) {
    $cases = $r.PassLines
  }

  if ($cases.Count -gt 0) {
    $md.Add('### Use Cases from Output')
    $md.Add('')
    $md.Add('| Use case |')
    $md.Add('|---|')
    foreach ($c in $cases) {
      $md.Add(("| {0} |" -f (Escape-Pipe $c)))
    }
    $md.Add('')
  }

  if ($r.ResultJson -and (Test-Path $r.ResultJson)) {
    try {
      $jsonObj = Get-Content -Raw -Path $r.ResultJson | ConvertFrom-Json

      if ($r.Slug -eq 'binary-load' -and $jsonObj.runs) {
        $md.Add('### Load Metrics')
        $md.Add('')
        $md.Add('| Size | Hz | Duration(s) | Sent | Received | Dropped | Drop % | P50 ms | P95 ms | P99 ms | Max ms | Avg ms | Jitter ms | Throughput B/s |')
        $md.Add('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
        foreach ($run in $jsonObj.runs) {
          $md.Add(("| {0} | {1} | {2} | {3} | {4} | {5} | {6:N2} | {7:N2} | {8:N2} | {9:N2} | {10:N2} | {11:N2} | {12:N2} | {13:N2} |" -f $run.size, $run.hz, $run.durationSec, $run.sent, $run.received, $run.dropped, $run.dropRatePct, $run.p50Ms, $run.p95Ms, $run.p99Ms, $run.maxMs, $run.avgMs, $run.jitterStdDevMs, $run.payloadBytesPerSec))
        }
        $md.Add('')
      }

      if ($r.Slug -eq 'binary-limit' -and $jsonObj.results) {
        $md.Add('### Limit Cases')
        $md.Add('')
        $md.Add('| Case | Passed | Key detail |')
        $md.Add('|---|---|---|')
        foreach ($case in $jsonObj.results) {
          $keyDetail = ''
          if ($case.details.receivedError) {
            $keyDetail = [string]$case.details.receivedError
          } elseif ($case.details.sweep) {
            $keyDetail = 'See rate sweep table'
          }
          $md.Add(("| {0} | {1} | {2} |" -f (Escape-Pipe $case.name), $case.passed, (Escape-Pipe $keyDetail)))
        }
        $md.Add('')

        $sweepCase = $jsonObj.results | Where-Object { $_.name -eq 'rate-limit-sweep-around-200hz' }
        if ($sweepCase -and $sweepCase.details.sweep) {
          $md.Add('### Rate Sweep')
          $md.Add('')
          $md.Add('| Hz | Duration ms | Sent | Received | Rate-limit hits | Delivery % |')
          $md.Add('|---:|---:|---:|---:|---:|---:|')
          foreach ($step in $sweepCase.details.sweep) {
            $md.Add(("| {0} | {1} | {2} | {3} | {4} | {5:N2} |" -f $step.hz, $step.durationMs, $step.sent, $step.received, $step.rateLimitHits, $step.deliveryRatePct))
          }
          $md.Add('')
        }
      }
    } catch {
      $md.Add('Could not parse result json for this test.')
      $md.Add('')
    }
  }
}

Set-Content -Path $reportPath -Value ($md -join "`r`n") -Encoding UTF8

Write-Title 'Suite complete'
Write-Output ("Suite folder: {0}" -f $suiteDir)
Write-Output ("Summary json: {0}" -f $summaryPath)
Write-Output ("Markdown report: {0}" -f $reportPath)

if (-not $overallPass) {
  exit 1
}
