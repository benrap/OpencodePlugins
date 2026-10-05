# install-shim.ps1
# Creates the shim directory (default %USERPROFILE%\.opencode-patched, override
# with $env:OPENCODE_PATCHED_DIR) and writes a binary-first opencode.cmd there.
# No machine-specific paths are hardcoded; everything is derived at runtime from
# environment variables and this script's own location.
#
# Standalone binary resolution (in priority order):
#   1. -BinaryPath <path>
#   2. $env:OPENCODE_PATCHED_BIN
#   3. <script-dir>\..\bin\opencode.exe      (artifact layout: scripts\..\bin)
#   4. <script-dir>\opencode.exe             (binary beside this script)
# When a standalone binary is found it is copied to
#   <shim-dir>\bin\opencode.exe
# and the shim runs it directly (no bun/node/source needed).
#
# Source fallback (used only when no binary is found):
#   1. -SourceDir <path>
#   2. $env:OPENCODE_PATCHED_SOURCE
#   3. $env:OPENCODE_CHECKOUT\packages\cli
#   4. <shim-dir>\opencode-src\packages\cli
#   5. the first <temp>\opencode\*\packages\cli that contains src\index.ts
# Steps 3-5 are discovered from environment variables only (no hardcoded paths).

[CmdletBinding()]
param(
    [string]$SourceDir,
    [string]$BinaryPath
)

$ErrorActionPreference = 'Stop'

$shimDir = if ($env:OPENCODE_PATCHED_DIR) {
    $env:OPENCODE_PATCHED_DIR
} else {
    Join-Path $env:USERPROFILE '.opencode-patched'
}

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Resolve-StandaloneBinary {
    param(
        [string]$ExplicitPath,
        [string]$ScriptDir
    )

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($ExplicitPath) { $candidates.Add($ExplicitPath) }
    if ($env:OPENCODE_PATCHED_BIN) { $candidates.Add($env:OPENCODE_PATCHED_BIN) }
    if ($ScriptDir) {
        $candidates.Add((Join-Path (Split-Path $ScriptDir -Parent) 'bin\opencode.exe'))
        $candidates.Add((Join-Path $ScriptDir 'opencode.exe'))
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

function Resolve-CheckoutCli {
    param([string]$ShimDir)

    $preferredBranch = 'benrap/session-waiting-status'

    # Explicit candidates first.
    $explicit = New-Object System.Collections.Generic.List[string]
    if ($env:OPENCODE_CHECKOUT) {
        $explicit.Add((Join-Path $env:OPENCODE_CHECKOUT 'packages\cli'))
    }
    $explicit.Add((Join-Path $ShimDir 'opencode-src\packages\cli'))
    foreach ($candidate in $explicit) {
        if ($candidate -and (Test-Path (Join-Path $candidate 'src\index.ts'))) {
            return $candidate
        }
    }

    # Then scan temp roots (derived from TEMP/LOCALAPPDATA, never hardcoded).
    $tempRoots = @()
    if ($env:TEMP) { $tempRoots += (Join-Path $env:TEMP 'opencode') }
    if ($env:LOCALAPPDATA) { $tempRoots += (Join-Path $env:LOCALAPPDATA 'Temp\opencode') }

    $found = New-Object System.Collections.Generic.List[object]
    foreach ($root in $tempRoots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $cli = Join-Path $_.FullName 'packages\cli'
            if (Test-Path (Join-Path $cli 'src\index.ts')) {
                $branch = ''
                try { $branch = ("" + (& git -C $_.FullName rev-parse --abbrev-ref HEAD 2>$null)).Trim() } catch { }
                $found.Add([pscustomobject]@{
                    Path      = $cli
                    Branch    = $branch
                    LastWrite = $_.LastWriteTime
                })
            }
        }
    }

    if ($found.Count -gt 0) {
        $preferred = $found |
            Sort-Object -Property @{ Expression = { if ($_.Branch -eq $preferredBranch) { 0 } else { 1 } } }, @{ Expression = { $_.LastWrite }; Descending = $true } |
            Select-Object -First 1
        Write-Host "Auto-detected patched checkout: $($preferred.Path) (branch '$($preferred.Branch)')" -ForegroundColor Cyan
        return $preferred.Path
    }

    return (Join-Path $ShimDir 'opencode-src\packages\cli')
}

# --- Resolve the standalone binary (preferred) ---
$binarySource = Resolve-StandaloneBinary -ExplicitPath $BinaryPath -ScriptDir $scriptDir
$installedBinary = Join-Path $shimDir 'bin\opencode.exe'

# --- Resolve the source fallback only if there is no binary ---
$sourceReady = $false
if (-not $binarySource) {
    if (-not $SourceDir) { $SourceDir = $env:OPENCODE_PATCHED_SOURCE }
    if (-not $SourceDir) { $SourceDir = Resolve-CheckoutCli -ShimDir $shimDir }
    if (Test-Path (Join-Path $SourceDir 'src\index.ts')) {
        $sourceReady = $true
    } else {
        Write-Host "Warning: no standalone binary found and '$SourceDir' does not contain src\index.ts." -ForegroundColor Yellow
        Write-Host "         Pass -BinaryPath, set OPENCODE_PATCHED_BIN, or pass -SourceDir / set OPENCODE_PATCHED_SOURCE." -ForegroundColor Yellow
    }
}

# --- Locate bun (only needed for the source fallback) ---
$bunExe = $null
if (-not $binarySource) {
    $bunExe = if ($env:BUN_EXE) { $env:BUN_EXE } else { $null }

    # 1. Try Get-Command
    if (-not $bunExe) {
        $cmd = Get-Command bun -ErrorAction SilentlyContinue
        if ($cmd) {
            $resolved = $cmd.Source
            # A .ps1/.cmd shim points at node_modules\bun\bin\bun.exe
            if ($resolved -match 'bun\.(ps1|cmd)$') {
                $npmDir = Split-Path $resolved -Parent
                $candidate = Join-Path $npmDir 'node_modules\bun\bin\bun.exe'
                if (Test-Path $candidate) { $bunExe = $candidate }
            } elseif ($resolved -match 'bun\.exe$') {
                $bunExe = $resolved
            }
        }
    }

    # 2. %APPDATA%\npm\node_modules\bun\bin\bun.exe
    if (-not $bunExe -and $env:APPDATA) {
        $candidate = Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe'
        if (Test-Path $candidate) { $bunExe = $candidate }
    }

    # 3. %USERPROFILE%\.bun\bin\bun.exe
    if (-not $bunExe -and $env:USERPROFILE) {
        $candidate = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
        if (Test-Path $candidate) { $bunExe = $candidate }
    }

    # 4. %LOCALAPPDATA%\bun\bun.exe
    if (-not $bunExe -and $env:LOCALAPPDATA) {
        $candidate = Join-Path $env:LOCALAPPDATA 'bun\bun.exe'
        if (Test-Path $candidate) { $bunExe = $candidate }
    }

    if (-not $bunExe) {
        Write-Host "Could not locate bun.exe; the shim will fall back to 'bun' on PATH." -ForegroundColor Yellow
        $bunExe = 'bun'
    }
}

# --- Create shim directory ---
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null

# --- Optionally install the standalone binary beside the shim ---
$hasInstalledBinary = $false
if ($binarySource) {
    New-Item -ItemType Directory -Force -Path (Split-Path $installedBinary -Parent) | Out-Null
    Copy-Item -Force -LiteralPath $binarySource -Destination $installedBinary
    $hasInstalledBinary = Test-Path -LiteralPath $installedBinary -PathType Leaf
    Write-Host "Installed standalone binary: $installedBinary (from $binarySource)" -ForegroundColor Green
}

# --- Write opencode.cmd (binary-first, source fallback) ---
$shimContent = @"
@echo off
rem Binary-first: run the standalone binary installed beside this shim.
if exist "%~dp0bin\opencode.exe" (
    "%~dp0bin\opencode.exe" %*
    exit /b %errorlevel%
)
rem Fallback: run the patched TypeScript source with bun.
"$bunExe" run --cwd "$SourceDir" src/index.ts %*
exit /b %errorlevel%
"@

$shimPath = Join-Path $shimDir 'opencode.cmd'
Set-Content -Path $shimPath -Value $shimContent -Encoding ASCII

if ($hasInstalledBinary) {
    Write-Host "Patched binary: $installedBinary" -ForegroundColor Green
} else {
    Write-Host "Patched source: $SourceDir" -ForegroundColor Green
}
Write-Host "Shim written to: $shimPath" -ForegroundColor Green
Write-Host ""
Write-Host "To activate, run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$shimDir\switch-patched.ps1`""
