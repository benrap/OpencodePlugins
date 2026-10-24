#requires -Version 5.1
<#
keep-awake-setup.ps1 - diagnose and (opt-in) fix the Windows on-battery
"Execution Required power request time-out" (EXECTIME) so keep-awake's power
requests are not terminated 5 minutes after the sleep timeout.

Why: on DC (battery), Windows terminates System+Execution power requests
300 seconds after the sleep timeout (Modern Standby). The relevant hidden power
setting is EXECTIME (subgroup SUB_IR, GUID
3166bc41-7e98-4e03-b34e-ec0f5f2b218e). Setting its DC value to 0xffffffff
disables that termination. This is machine-wide, so powercfg's set commands
require Administrator.

Usage:
  keep-awake-setup.ps1                 # diagnose only (never elevates)
  keep-awake-setup.ps1 -Check          # same as no args
  keep-awake-setup.ps1 -Apply          # print notice, then one UAC elevation
  keep-awake-setup.ps1 -Revert         # restore the 300 s default (one UAC)

  -Apply / -Revert self-elevate with exactly one UAC prompt via
  Start-Process -Verb RunAs. The elevated child is passed -Elevated so it never
  re-elevates. Nothing is applied silently.

Exit codes: 0 success, non-zero on failure.

This script does NOT change lid-close or power-button behavior.
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Apply,
  [switch]$Revert,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

# The two command strings. Join with '; ' so each is a single runnable line
# (matches the plugin's execFixCommands()).
$ApplyCommand = 'powercfg /setdcvalueindex SCHEME_CURRENT SUB_IR EXECTIME 0xffffffff; powercfg /setactive SCHEME_CURRENT'
$RevertCommand = 'powercfg /setdcvalueindex SCHEME_CURRENT SUB_IR EXECTIME 0x12c; powercfg /setactive SCHEME_CURRENT'
$FixedDcValue = 0xffffffff

function Write-Line([string]$Text) {
  Write-Output $Text
}

function Test-IsElevated {
  try {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

# Read the EXECTIME DC value non-elevated by parsing
# `powercfg /qh SCHEME_CURRENT SUB_IR` and isolating the EXECTIME section
# (from "GUID Alias: EXECTIME" to the next "Power Setting GUID") so a later
# setting's DC value is never mistaken for this one.
function Get-ExecTimeDc {
  $out = ''
  try {
    $out = (& powercfg /qh SCHEME_CURRENT SUB_IR 2>$null | Out-String)
  } catch {
    return $null
  }
  $idx = $out.IndexOf('GUID Alias: EXECTIME')
  if ($idx -lt 0) { return $null }
  $section = $out.Substring($idx)
  $next = $section.IndexOf('Power Setting GUID')
  if ($next -ge 0) { $section = $section.Substring(0, $next) }
  $m = [regex]::Match($section, 'Current DC Power Setting Index:\s*(0x[0-9a-fA-F]+|\d+)')
  if (-not $m.Success) { return $null }
  $raw = $m.Groups[1].Value
  try {
    if ($raw -like '0x*') { return [Convert]::ToInt64($raw.Substring(2), 16) }
    return [int64]$raw
  } catch {
    return $null
  }
}

function Write-Notice([object]$DcValue) {
  $dcText = if ($null -eq $DcValue) { 'unknown' } else { "$DcValue" }
  Write-Line ''
  Write-Line '=================================================================='
  Write-Line ' keep-awake: Windows on-battery "Execution Required" timeout notice'
  Write-Line '=================================================================='
  Write-Line " EXECTIME DC (Current DC Power Setting Index) = $dcText seconds"
  Write-Line ''
  Write-Line ' What is wrong'
  Write-Line '   On battery (DC), Windows terminates System+Execution power'
  Write-Line '   requests 5 minutes after the sleep timeout, so keep-awake alone'
  Write-Line '   is defeated on Modern Standby machines.'
  Write-Line ''
  Write-Line ' How to fix (requires Administrator)'
  Write-Line '   Power schemes are machine-wide, so powercfg set commands need'
  Write-Line '   elevation. Apply command:'
  Write-Line "     $ApplyCommand"
  Write-Line ''
  Write-Line '   Either:'
  Write-Line '     1. Run keep-awake-setup.ps1 -Apply from an elevated PowerShell,'
  Write-Line '        OR'
  Write-Line '     2. Set "setupMode":"apply" in the keep-awake plugin options'
  Write-Line '        (opt-in; one UAC prompt), OR'
  Write-Line '     3. Run the command above yourself.'
  Write-Line ''
  Write-Line ' To decline or apply later'
  Write-Line '   Leave setupMode at "detect" (default) or "off". Nothing changes'
  Write-Line '   silently.'
  Write-Line ''
  Write-Line ' Caveat'
  Write-Line '   This does not change lid-close or power-button actions. A'
  Write-Line '   user-initiated sleep still terminates power requests.'
  Write-Line ''
  Write-Line " Revert command (restore the 300 s default): $RevertCommand"
  Write-Line ''
}

# Self-elevate exactly once. Returns the elevated child's exit code, or 1 if
# elevation was cancelled/failed (with manual instructions).
function Invoke-SelfElevate([string[]]$ChildArgs) {
  $self = $PSCommandPath
  if (-not $self) { $self = $MyInvocation.MyCommand.Path }
  $argLine = (($ChildArgs + @('-Elevated')) -join ' ')
  try {
    $proc = Start-Process -Verb RunAs -Wait -PassThru -FilePath 'powershell.exe' `
      -ArgumentList "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$self`" $argLine"
    if ($null -ne $proc) { return $proc.ExitCode }
    return 0
  } catch {
    Write-Line ''
    Write-Line "Elevation was cancelled or failed: $($_.Exception.Message)"
    Write-Line 'Run this from an elevated PowerShell instead:'
    Write-Line "  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$self`" $($ChildArgs -join ' ')"
    return 1
  }
}

function Invoke-Commands([string]$CommandLine) {
  try {
    Invoke-Expression $CommandLine
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [int]$code
  } catch {
    Write-Line "Command failed: $($_.Exception.Message)"
    return 1
  }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if ($Apply -or $Revert) {
  $childArg = if ($Apply) { '-Apply' } else { '-Revert' }
  $commandLine = if ($Apply) { $ApplyCommand } else { $RevertCommand }
  $action = if ($Apply) { 'apply' } else { 'revert' }

  if (-not (Test-IsElevated) -and -not $Elevated) {
    # Print the notice FIRST, then request exactly one UAC elevation.
    Write-Notice (Get-ExecTimeDc)
    exit (Invoke-SelfElevate @($childArg))
  }

  $before = Get-ExecTimeDc
  Write-Line "EXECTIME DC before: $(if ($null -eq $before) { 'unknown' } else { $before })"
  Write-Line "Running ($action): $commandLine"
  $code = Invoke-Commands $commandLine
  $after = Get-ExecTimeDc
  Write-Line "EXECTIME DC after:  $(if ($null -eq $after) { 'unknown' } else { $after })"
  if ($code -ne 0) {
    Write-Line "ERROR: command exited with code $code"
    exit $code
  }
  if ($Apply -and $null -ne $after -and $after -ne $FixedDcValue) {
    Write-Line 'ERROR: EXECTIME DC was not set to 0xffffffff'
    exit 1
  }
  if ($Revert -and $null -ne $after -and $after -eq $FixedDcValue) {
    Write-Line 'ERROR: EXECTIME DC is still 0xffffffff after revert'
    exit 1
  }
  Write-Line "Done ($action)."
  exit 0
}

# No -Apply / -Revert: diagnose only. This branch never elevates.
$dc = Get-ExecTimeDc
if ($null -eq $dc) {
  Write-Line 'EXECTIME DC: could not be read (powercfg output not parseable).'
} elseif ($dc -eq $FixedDcValue) {
  Write-Line "EXECTIME DC: $dc (0xffffffff) - fixed; power requests can persist on battery."
} else {
  Write-Line "EXECTIME DC: $dc seconds - unfixed; keep-awake will be defeated on battery."
}
Write-Line "Running elevated: $(Test-IsElevated)"
Write-Notice $dc
exit 0
