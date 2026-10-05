<#
.SYNOPSIS
    Install the pre-commit hook that runs the local-path guard.

.DESCRIPTION
    Writes a portable .git/hooks/pre-commit that shells out to
    check-no-local-paths.ps1 in the same repo. Git for Windows runs hooks with
    sh, so the hook is a POSIX shell script and resolves the repo root itself
    (no absolute paths are embedded). Re-run after a fresh clone.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-git-hooks.ps1
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

$hooksDir = Join-Path $RepoRoot '.git\hooks'
New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
$hookPath = Join-Path $hooksDir 'pre-commit'

$content = @'
#!/bin/sh
# Reject machine-specific local filesystem paths (installed by
# patched-opencode/scripts/install-git-hooks.ps1).
root="$(git rev-parse --show-toplevel)" || exit 1
if command -v powershell >/dev/null 2>&1; then
  exec powershell -NoProfile -ExecutionPolicy Bypass -File "$root/patched-opencode/scripts/check-no-local-paths.ps1" -RepoRoot "$root"
elif command -v pwsh >/dev/null 2>&1; then
  exec pwsh -NoProfile -ExecutionPolicy Bypass -File "$root/patched-opencode/scripts/check-no-local-paths.ps1" -RepoRoot "$root"
else
  echo "pre-commit: PowerShell not found; skipping local-path guard" >&2
  exit 0
fi
'@

# Git for Windows' sh dislikes CRLF in a shebang; write LF only, no BOM.
$content = $content -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($hookPath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Installed pre-commit guard: $hookPath" -ForegroundColor Green
