#requires -Version 5.1
<#
keep-awake.ps1 - hold a Windows power request until killed.

Acquires a Power Request (PowerCreateRequest/PowerSetRequest) for
PowerRequestExecutionRequired + PowerRequestSystemRequired only; the display is
deliberately NOT requested (it may power off), and the request is held for as
long as this process lives.

Only ONE helper across all OpenCode processes actually holds the request: the
helper first takes an exclusive named mutex ("OpenCodeKeepAwakePower"). Helpers
that do not get the mutex print WAITING and block until the holder exits
(cleanly or by being killed, which abandons the mutex), then take over. This
keeps the machine awake whenever any OpenCode server wants it, without stacking
duplicate requests.

Falls back to SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
(display not requested) if the Power Request API is unavailable.

Exits on its own when:
  - -MaxSeconds elapses (safety valve), or
  - -ParentPid is supplied and that process no longer exists (orphan guard).

Prints machine-readable acquisition lines on stdout:
  READY power execution=True system=True display=requested=false
  READY executionstate
  WAITING for existing keep-awake holder
  ERROR <message>
#>
[CmdletBinding()]
param(
  [int]$ParentPid = 0,
  [int]$MaxSeconds = 43200,
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

# ES flags. Use decimal literals so PowerShell assigns them as Int64 and the
# explicit uint32 cast never overflows (0x80000000 alone parses as Int32).
$ES_CONTINUOUS_ONLY = [uint32]2147483648    # 0x80000000
$ES_KEEP_AWAKE = [uint32]2147483649         # 0x80000001 = CONTINUOUS|SYSTEM_REQUIRED (display free to power off)

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

# POWER_REQUEST_TYPE values
$PowerRequestSystemRequired = 1
$PowerRequestExecutionRequired = 3

function Set-PowerHold {
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
      if ($exec -or $sys) {
        $script:mode = 'power'
        Write-Out ("READY power execution=$exec system=$sys display=requested=false")
        return $true
      }
      [void][KeepAwakeNative]::CloseHandle($handle)
      $script:powerHandle = [IntPtr]::Zero
    }
  } catch {
    Write-Out ("WARN Power request API failed: " + $_.Exception.Message)
    if ($script:powerHandle -ne [IntPtr]::Zero) {
      try { [void][KeepAwakeNative]::CloseHandle($script:powerHandle) } catch { }
      $script:powerHandle = [IntPtr]::Zero
    }
  }

  # Fallback: SetThreadExecutionState
  try {
    $prev = [KeepAwakeNative]::SetThreadExecutionState($ES_KEEP_AWAKE)
    if ($prev -ne [uint32]0) {
      $script:mode = 'executionstate'
      Write-Out "READY executionstate"
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
      $script:mutex = New-Object System.Threading.Mutex($false, 'OpenCodeKeepAwakePower', [ref]$createdNew)
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
      [void][KeepAwakeNative]::PowerClearRequest($script:powerHandle, $PowerRequestExecutionRequired)
      [void][KeepAwakeNative]::PowerClearRequest($script:powerHandle, $PowerRequestSystemRequired)
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
