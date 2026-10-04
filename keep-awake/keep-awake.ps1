#requires -Version 5.1
<#
keep-awake.ps1 - hold a Windows power request until killed.

Acquires a Power Request (PowerCreateRequest/PowerSetRequest) for
PowerRequestExecutionRequired + PowerRequestSystemRequired, and (when
-Display on) PowerRequestDisplayRequired. Requesting the display is what
actually defeats Modern Standby on battery; the cost is that the screen stays
lit and the screensaver/auto-lock and idle scheduled tasks are blocked.
Pass -Display on to request the display; the default is off (system/execution
requests only; the display may power off).

Only ONE helper across all OpenCode processes actually holds the request: the
helper first takes an exclusive named mutex (default "OpenCodeKeepAwakePower",
override with -MutexName). Helpers that do not get the mutex print WAITING and
block until the holder exits (cleanly or by being killed, which abandons the
mutex), then take over. This keeps the machine awake whenever any OpenCode
server wants it, without stacking duplicate requests.

Falls back to
  SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
  (0x80000003) when -Display on, or
  SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
  (0x80000001) when -Display off,
if the Power Request API is unavailable. -ForceExecutionState is a test-only
hook that skips the Power Request API and exercises this fallback.

POWER_REQUEST_TYPE values used (documented enum order):
  PowerRequestDisplayRequired   = 0
  PowerRequestSystemRequired    = 1
  PowerRequestAwayModeRequired  = 2  (NOT used)
  PowerRequestExecutionRequired = 3

Exits on its own when:
  - -MaxSeconds elapses (safety valve), or
  - -ParentPid is supplied and that process no longer exists (orphan guard).

Prints machine-readable acquisition lines on stdout:
  READY power execution=True system=True display=true displayRequested=true
  READY power execution=True system=True display=false displayRequested=false
  READY executionstate display=true
  READY executionstate display=false
  WAITING for existing keep-awake holder
  ERROR <message>
#>
[CmdletBinding()]
param(
  [int]$ParentPid = 0,
  [int]$MaxSeconds = 43200,
  [ValidateSet('on','off')]
  [string]$Display = 'off',
  [string]$MutexName = 'OpenCodeKeepAwakePower',
  [switch]$ForceExecutionState,
  [string]$Label = 'opencode-agent-busy'
)

$ErrorActionPreference = 'Stop'

function Write-Out([string]$Text) {
  try {
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
  } catch { }
}

$script:mode = 'none'
$script:powerHandle = [IntPtr]::Zero
$script:reasonPtr = [IntPtr]::Zero
$script:mutex = $null
$script:holdsMutex = $false
$script:displaySet = $false

# ES flags. Use decimal literals so PowerShell assigns them as Int64 and the
# explicit uint32 cast never overflows (0x80000000 alone parses as Int32).
$ES_CONTINUOUS_ONLY = [uint32]2147483648      # 0x80000000
$ES_KEEP_AWAKE = [uint32]2147483649           # 0x80000001 = CONTINUOUS|SYSTEM_REQUIRED (display free to power off)
$ES_KEEP_AWAKE_DISPLAY = [uint32]2147483651   # 0x80000003 = CONTINUOUS|SYSTEM_REQUIRED|DISPLAY_REQUIRED

$csharp = @'
using System;
using System.Runtime.InteropServices;

public static class KeepAwakeNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct REASON_CONTEXT
    {
        public uint Version;
        public uint Flags;
        public IntPtr SimpleReasonString;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT Context);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool PowerSetRequest(IntPtr PowerRequest, int RequestType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool PowerClearRequest(IntPtr PowerRequest, int RequestType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

try {
  Add-Type -TypeDefinition $csharp -Language CSharp -ErrorAction Stop
} catch {
  Write-Out ("ERROR Add-Type failed: " + $_.Exception.Message)
  exit 2
}

# POWER_REQUEST_TYPE values (documented enum order; AwayMode=2 is NOT used).
$PowerRequestDisplayRequired = 0
$PowerRequestSystemRequired = 1
$PowerRequestExecutionRequired = 3

function Set-PowerHold {
  # -ForceExecutionState is a test-only hook: skip the Power Request API and
  # exercise the SetThreadExecutionState fallback below.
  if (-not $ForceExecutionState) {
    # Try the Power Request API first (the reliable path on Modern Standby).
    try {
      $reason = New-Object KeepAwakeNative+REASON_CONTEXT
      $reason.Version = 0
      $reason.Flags = 1 # POWER_REQUEST_CONTEXT_SIMPLE_STRING
      if ($script:reasonPtr -eq [IntPtr]::Zero) {
        $script:reasonPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($Label)
      }
      $reason.SimpleReasonString = $script:reasonPtr

      $handle = [KeepAwakeNative]::PowerCreateRequest([ref]$reason)
      if ($handle -ne [IntPtr]::Zero -and $handle -ne [IntPtr](-1)) {
        $script:powerHandle = $handle
        $exec = [KeepAwakeNative]::PowerSetRequest($handle, $PowerRequestExecutionRequired)
        $sys = [KeepAwakeNative]::PowerSetRequest($handle, $PowerRequestSystemRequired)
        $displayOk = $false
        $displayRequested = $false
        if ($Display -eq 'on') {
          $displayRequested = $true
          $displayOk = [KeepAwakeNative]::PowerSetRequest($handle, $PowerRequestDisplayRequired)
          if ($displayOk) { $script:displaySet = $true }
        }
        if ($exec -or $sys) {
          $script:mode = 'power'
          $displayText = if ($displayOk) { 'true' } else { 'false' }
          $displayReqText = if ($displayRequested) { 'true' } else { 'false' }
          Write-Out ("READY power execution=$exec system=$sys display=$displayText displayRequested=$displayReqText")
          return $true
        }
        [void][KeepAwakeNative]::CloseHandle($handle)
        $script:powerHandle = [IntPtr]::Zero
        $script:displaySet = $false
      }
    } catch {
      Write-Out ("WARN Power request API failed: " + $_.Exception.Message)
      if ($script:powerHandle -ne [IntPtr]::Zero) {
        try { [void][KeepAwakeNative]::CloseHandle($script:powerHandle) } catch { }
        $script:powerHandle = [IntPtr]::Zero
      }
      $script:displaySet = $false
    }
  }

  # Fallback: SetThreadExecutionState.
  try {
    $flags = if ($Display -eq 'on') { $ES_KEEP_AWAKE_DISPLAY } else { $ES_KEEP_AWAKE }
    $prev = [KeepAwakeNative]::SetThreadExecutionState($flags)
    if ($prev -ne [uint32]0) {
      $script:mode = 'executionstate'
      $displayText = if ($Display -eq 'on') { 'true' } else { 'false' }
      Write-Out ("READY executionstate display=$displayText")
      return $true
    }
  } catch {
    Write-Out ("ERROR fallback failed: " + $_.Exception.Message)
  }
  return $false
}

function Test-Mutex {
  if ($script:holdsMutex) { return $true }
  try {
    if ($null -eq $script:mutex) {
      $createdNew = $false
      $script:mutex = New-Object System.Threading.Mutex($false, $MutexName, [ref]$createdNew)
    }
    try {
      $acquired = $script:mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
      # Previous holder was killed without releasing; we now own it.
      $acquired = $true
    }
    if ($acquired) { $script:holdsMutex = $true; return $true }
  } catch {
    # If the mutex itself is unavailable, fail open so we still keep awake.
    Write-Out ("WARN mutex unavailable, holding anyway: " + $_.Exception.Message)
    $script:holdsMutex = $true
    return $true
  }
  return $false
}

function Test-ParentAlive {
  if ($ParentPid -le 0) { return $true }
  $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  return ($null -ne $p)
}

try {
  if ($MaxSeconds -le 0) { $MaxSeconds = 43200 }
  $deadline = (Get-Date).AddSeconds($MaxSeconds)

  # Wait for the single global holder slot.
  $announcedWaiting = $false
  while (-not (Test-Mutex)) {
    if (-not $announcedWaiting) {
      Write-Out "WAITING for existing keep-awake holder"
      $announcedWaiting = $true
    }
    if (-not (Test-ParentAlive)) { exit 0 }
    if ((Get-Date) -ge $deadline) { exit 0 }
    Start-Sleep -Milliseconds 500
  }

  if (-not (Set-PowerHold)) {
    Write-Out "ERROR could not acquire any power request"
    exit 3
  }

  # Hold until killed, parent dies, or max time elapses.
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-ParentAlive)) { break }
    Start-Sleep -Seconds 2
  }
} finally {
  try {
    if ($script:mode -eq 'power' -and $script:powerHandle -ne [IntPtr]::Zero) {
      if ($script:displaySet) {
        [void][KeepAwakeNative]::PowerClearRequest($script:powerHandle, $PowerRequestDisplayRequired)
      }
      [void][KeepAwakeNative]::PowerClearRequest($script:powerHandle, $PowerRequestSystemRequired)
      [void][KeepAwakeNative]::PowerClearRequest($script:powerHandle, $PowerRequestExecutionRequired)
      [void][KeepAwakeNative]::CloseHandle($script:powerHandle)
      $script:powerHandle = [IntPtr]::Zero
    } elseif ($script:mode -eq 'executionstate') {
      [void][KeepAwakeNative]::SetThreadExecutionState($ES_CONTINUOUS_ONLY)
    }
  } catch { }
  if ($script:reasonPtr -ne [IntPtr]::Zero) {
    try { [Runtime.InteropServices.Marshal]::FreeHGlobal($script:reasonPtr) } catch { }
    $script:reasonPtr = [IntPtr]::Zero
  }
  if ($script:mutex -ne $null) {
    if ($script:holdsMutex) { try { [void]$script:mutex.ReleaseMutex() } catch { } }
    try { $script:mutex.Dispose() } catch { }
  }
}
