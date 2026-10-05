# switch-patched.ps1
# Prepends the patched shim directory (default: %USERPROFILE%\.opencode-patched,
# override with $env:OPENCODE_PATCHED_DIR) to the User PATH so that `opencode`
# resolves to the patched shim (opencode.cmd) in new shells.
# Idempotent: safe to run multiple times.

$ErrorActionPreference = 'Stop'

$shimDir = if ($env:OPENCODE_PATCHED_DIR) {
    $env:OPENCODE_PATCHED_DIR
} else {
    Join-Path $env:USERPROFILE '.opencode-patched'
}

# Read current User PATH
$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')

if ([string]::IsNullOrWhiteSpace($currentPath)) {
    $entries = @()
} else {
    # Split on ';' and trim, dropping empties
    $entries = $currentPath.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
}

# Check if already present (case-insensitive)
$alreadyPresent = $entries | Where-Object { $_.TrimEnd('\') -ieq $shimDir.TrimEnd('\') }

if ($alreadyPresent) {
    Write-Host "Already patched: '$shimDir' is already in the User PATH." -ForegroundColor Yellow
} else {
    # Prepend the shim dir
    $newEntries = @($shimDir) + $entries
    $newPath = $newEntries -join ';'

    # Write back via .NET (preserves REG_EXPAND_SZ when possible)
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')

    # Also write to HKCU:\Environment\Path for persistence across sessions
    $regPath = 'HKCU:\Environment'
    if (Test-Path $regPath) {
        $regValue = (Get-ItemProperty -Path $regPath -Name 'Path' -ErrorAction SilentlyContinue).Path
        if ($regValue -ne $newPath) {
            Set-ItemProperty -Path $regPath -Name 'Path' -Value $newPath -Type ExpandString
        }
    }

    Write-Host "SUCCESS: '$shimDir' has been prepended to the User PATH." -ForegroundColor Green
}

Write-Host ""
Write-Host "New User PATH:"
Write-Host "--------------"
$verifyPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Write-Host $verifyPath
Write-Host ""
Write-Host "Please open a NEW cmd or PowerShell window for the change to take effect." -ForegroundColor Cyan
Write-Host "In the new window, run: opencode --version"
Write-Host "You should see: opencode v2.0.23-patched"
