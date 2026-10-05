<#
.SYNOPSIS
    Reject machine-specific local filesystem paths in git-tracked files.

.DESCRIPTION
    Scans git-tracked files (working tree) for absolute user-profile paths and
    other machine-specific markers. Exits 1 and prints the offenders when any
    are found, so it can be used directly or from a pre-commit hook.

    The patterns are deliberately narrow: the bare GitHub username (for example
    https://github.com/benrap/...), an "author" field, a LICENSE copyright, and
    the branch name benrap/session-waiting-status are NOT flagged. Only real
    filesystem paths are.

.PARAMETER RepoRoot
    Repository root to scan. Defaults to the current git toplevel.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\check-no-local-paths.ps1
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = (git rev-parse --show-toplevel)
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    Write-Error "Not inside a git repository (could not resolve --show-toplevel)."
    exit 2
}

# Narrow patterns so legitimate URLs/authors never match:
#   * drive-qualified C:\Users\... / C:/Users/... (also JSON-escaped C:\\Users\\)
#   * a Users\<name> segment naming the repo owner's account
#   * an AppData\ or AppData/ path segment
#   * the temp-checkout name
#   * a drive-qualified path ending in the local shim directory
$pattern = 'C:[\\/]+Users[\\/]|Users[\\/]+benrap|AppData[\\/]|opencode-waiting|C:[\\/]+.*\.opencode-patched'

# The guard's own sources embed these strings as regex text and fixtures, so
# exclude them from the scan (they are checked by the self-test instead).
$paths = @(
    '.'
    ':(exclude)patched-opencode/scripts/check-no-local-paths.ps1'
    ':(exclude)patched-opencode/scripts/test-no-local-paths-guard.ps1'
)

$matches = & git -C $RepoRoot grep -n -I -i -E $pattern -- $paths
$exit = $LASTEXITCODE

if ($exit -eq 0 -and $matches) {
    Write-Host "FAIL: machine-specific local paths found in tracked files:" -ForegroundColor Red
    Write-Host ""
    $matches | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "Replace them with portable placeholders (e.g. %USERPROFILE%, <repo-root>)" -ForegroundColor Yellow
    Write-Host "or resolve them at runtime from environment variables." -ForegroundColor Yellow
    exit 1
}

# git grep returns 1 when there are no matches (clean) and >1 on error.
if ($exit -gt 1) {
    Write-Error "git grep failed with exit code $exit"
    exit $exit
}

Write-Host "OK: no machine-specific local paths in tracked files." -ForegroundColor Green
exit 0
