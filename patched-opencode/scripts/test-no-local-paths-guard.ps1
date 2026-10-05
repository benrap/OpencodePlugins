<#
.SYNOPSIS
    Self-test for check-no-local-paths.ps1.

.DESCRIPTION
    Creates a throwaway git repository, plants a machine-specific path in a
    tracked file, asserts the checker FAILS (non-zero exit), then replaces the
    plant with a portable line and asserts the checker PASSES (exit 0).
    This script intentionally contains a planted path as a fixture, so the
    checker excludes it from real scans.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\test-no-local-paths-guard.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$checker = Join-Path $here 'check-no-local-paths.ps1'

if (-not (Test-Path $checker)) {
    Write-Error "checker not found next to the self-test: $checker"
    exit 2
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("no-local-paths-guard-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
    & git -C $temp init --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git init failed in $temp" }
    & git -C $temp config user.email 'guard-test@example.invalid' 2>$null
    & git -C $temp config user.name 'guard-test' 2>$null

    $sample = Join-Path $temp 'sample.txt'

    $plant = 'log written to C:\Users\someone\AppData\Local\Temp\opencode\opencode-waiting\out.log'
    Set-Content -Path $sample -Value $plant -Encoding ASCII
    & git -C $temp add sample.txt 2>$null

    Write-Host "--- planted leak: expecting FAIL ---" -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File $checker -RepoRoot $temp
    $failCode = $LASTEXITCODE
    if ($failCode -eq 0) {
        Write-Host "SELF-TEST FAILED: checker passed on a planted leak." -ForegroundColor Red
        exit 1
    }
    Write-Host "PASS: checker rejected the plant (exit $failCode)." -ForegroundColor Green

    Write-Host ""
    Write-Host "--- clean file: expecting PASS ---" -ForegroundColor Cyan
    Set-Content -Path $sample -Value 'portable path: %USERPROFILE%\.config\opencode\plugins' -Encoding ASCII
    & git -C $temp add sample.txt 2>$null
    & powershell -NoProfile -ExecutionPolicy Bypass -File $checker -RepoRoot $temp
    $passCode = $LASTEXITCODE
    if ($passCode -ne 0) {
        Write-Host "SELF-TEST FAILED: checker rejected a clean file (exit $passCode)." -ForegroundColor Red
        exit 1
    }
    Write-Host "PASS: checker accepted the clean file (exit $passCode)." -ForegroundColor Green

    Write-Host ""
    Write-Host "SELF-TEST PASSED" -ForegroundColor Green
    exit 0
}
finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
