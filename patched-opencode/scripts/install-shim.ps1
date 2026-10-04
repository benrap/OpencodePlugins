# install-shim.ps1
# Creates %USERPROFILE%\.opencode-patched\ and writes opencode.cmd there,
# locating bun automatically. Self-contained for fresh installs.

$ErrorActionPreference = 'Stop'

$shimDir = '%USERPROFILE%\.opencode-patched'
$sourceDir = '<opencode-checkout>\packages\cli'

# --- Locate bun ---
$bunExe = $null

# 1. Try Get-Command
$cmd = Get-Command bun -ErrorAction SilentlyContinue
if ($cmd) {
    $resolved = $cmd.Source
    # If it's a .ps1 shim, it points to node_modules\bun\bin\bun.exe
    if ($resolved -match 'bun\.ps1$') {
        $npmDir = Split-Path $resolved -Parent
        $candidate = Join-Path $npmDir 'node_modules\bun\bin\bun.exe'
        if (Test-Path $candidate) { $bunExe = $candidate }
    } elseif ($resolved -match 'bun\.cmd$') {
        $npmDir = Split-Path $resolved -Parent
        $candidate = Join-Path $npmDir 'node_modules\bun\bin\bun.exe'
        if (Test-Path $candidate) { $bunExe = $candidate }
    } elseif ($resolved -match 'bun\.exe$') {
        $bunExe = $resolved
    }
}

# 2. Try common location
if (-not $bunExe) {
    $candidate = '%USERPROFILE%\AppData\Roaming\npm\node_modules\bun\bin\bun.exe'
    if (Test-Path $candidate) { $bunExe = $candidate }
}

# 3. Try .bun dir
if (-not $bunExe) {
    $candidate = '%USERPROFILE%\.bun\bin\bun.exe'
    if (Test-Path $candidate) { $bunExe = $candidate }
}

if (-not $bunExe) {
    Write-Error "Could not locate bun.exe. Please install bun or set BUN_EXE environment variable."
    exit 1
}

Write-Host "Found bun at: $bunExe" -ForegroundColor Green

# --- Create shim directory ---
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null

# --- Write opencode.cmd ---
$shimContent = @"
@echo off
"$bunExe" run --cwd "$sourceDir" src/index.ts %*
exit /b %errorlevel%
"@

$shimPath = Join-Path $shimDir 'opencode.cmd'
Set-Content -Path $shimPath -Value $shimContent -Encoding ASCII

Write-Host "Shim written to: $shimPath" -ForegroundColor Green
Write-Host ""
Write-Host "To activate, run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File %USERPROFILE%\.opencode-patched\switch-patched.ps1"
