# revert-patched.ps1
# Removes %USERPROFILE%\.opencode-patched from the User PATH, restoring
# stock opencode resolution. Idempotent: safe to run multiple times.

$ErrorActionPreference = 'Stop'

$shimDir = '%USERPROFILE%\.opencode-patched'

# Read current User PATH
$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')

if ([string]::IsNullOrWhiteSpace($currentPath)) {
    $entries = @()
} else {
    $entries = $currentPath.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
}

# Check if present (case-insensitive)
$present = $entries | Where-Object { $_.TrimEnd('\') -ieq $shimDir.TrimEnd('\') }

if (-not $present) {
    Write-Host "Not patched: '$shimDir' is not in the User PATH. Nothing to do." -ForegroundColor Yellow
} else {
    # Remove the shim dir
    $newEntries = $entries | Where-Object { $_.TrimEnd('\') -ine $shimDir.TrimEnd('\') }
    $newPath = $newEntries -join ';'

    # Write back via .NET
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')

    # Also update HKCU:\Environment\Path
    $regPath = 'HKCU:\Environment'
    if (Test-Path $regPath) {
        $regValue = (Get-ItemProperty -Path $regPath -Name 'Path' -ErrorAction SilentlyContinue).Path
        if ($regValue -ne $newPath) {
            Set-ItemProperty -Path $regPath -Name 'Path' -Value $newPath -Type ExpandString
        }
    }

    Write-Host "SUCCESS: '$shimDir' has been removed from the User PATH." -ForegroundColor Green
}

Write-Host ""
Write-Host "Restored User PATH:"
Write-Host "-------------------"
$verifyPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Write-Host $verifyPath
Write-Host ""
Write-Host "Please open a NEW cmd or PowerShell window for the change to take effect." -ForegroundColor Cyan
Write-Host "In the new window, `opencode` will resolve to the stock binary again."
