# keep-awake

An OpenCode V2 plugin that keeps a **Windows** machine awake (no sleep) while
any OpenCode session/agent is busy. By default it **allows the display to power
off**; set `keepDisplayOn: true` (or `mode: "display"`) to also keep the display
on, because on Modern Standby machines a system-only power request is defeated by
Windows after ~5 minutes on battery.

**Windows-only.** On non-Windows hosts the plugin is a harmless no-op.

## How it works

The plugin subscribes to the OpenCode event stream. On
`session.execution.started` it spawns `keep-awake.ps1`, which acquires Windows
Power Requests (`PowerRequestExecutionRequired` + `PowerRequestSystemRequired`,
plus `PowerRequestDisplayRequired` when display mode is on). When the busy
sessions finish, the helper process is released (with a short debounce). The
helper:

- uses an exclusive named mutex so at most one helper holds the power request
  across all OpenCode processes;
- falls back to `SetThreadExecutionState` when the Power Request API is
  unavailable (`0x80000003` = continuous | system | display when display mode is
  on, `0x80000001` = continuous | system when off);
- exits on its own if the parent process dies or `maxSeconds` elapses.

## Display mode (default: off)

`keepDisplayOn` defaults to **false**: the helper does not request the display,
so it may power off while the machine stays awake.

**Cost of display-on:** the screen stays lit and the screensaver/auto-lock and
idle Task Scheduler tasks are blocked while a session is busy.

To keep the display on instead, either set `"keepDisplayOn": true` or use
the alias `"mode": "display"` (the alias `"mode": "system"` means off). An
explicit boolean `keepDisplayOn` always wins over `mode`.

## First-run battery-timeout detection

On battery (DC), Windows may terminate System+Execution power requests 300
seconds after the sleep timeout (hidden power setting `EXECTIME`, subgroup
`SUB_IR`). If that is unfixed, keep-awake alone is defeated on battery.

On first setup the plugin reads the current `EXECTIME` DC value with
`powercfg /qh SCHEME_CURRENT SUB_IR` (no admin needed) and, if it is unfixed,
prints a **one-time notice** with the exact commands. By default nothing is
changed.

**Apply the fix (requires Administrator).** Power schemes are machine-wide, so
`powercfg`'s set commands need elevation. The exact commands are:

```powershell
powercfg /setdcvalueindex SCHEME_CURRENT SUB_IR EXECTIME 0xffffffff; powercfg /setactive SCHEME_CURRENT
```

To revert to the 300 s default:

```powershell
powercfg /setdcvalueindex SCHEME_CURRENT SUB_IR EXECTIME 0x12c; powercfg /setactive SCHEME_CURRENT
```

Three ways to apply:

1. Run `keep-awake-setup.ps1 -Apply` from an elevated PowerShell
   (or just run `keep-awake-setup.ps1` for a diagnosis). It prints the notice
   first and requests exactly one UAC prompt.
2. Set `"setupMode": "apply"` in the keep-awake plugin options — this is the
   explicit opt-in consent that allows a single UAC elevation.
3. Run the commands yourself.

To decline, or apply later, leave `setupMode` at `detect` (default) or set it to
`off`. Nothing changes silently. The one-time notice is recorded in
`stateFile` (`~/.config/opencode/keep-awake/setup-state.json` by default) so it
is not repeated across restarts.

**Caveat:** this does **not** change lid-close or power-button behavior. A
user-initiated sleep still terminates power requests.

## Install

```bash
opencode plugin add ./keep-awake
```

Or reference the path in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "./keep-awake", "options": { "releaseDelayMs": 1500, "maxSeconds": 43200, "keepDisplayOn": false } }
  ]
}
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `releaseDelayMs` | `1500` | Debounce before releasing the helper once no session is busy. |
| `maxSeconds` | `43200` | Safety valve: helper exits after this many seconds (cumulative cap per busy period). |
| `debug` | `false` | Verbose logging. |
| `keepDisplayOn` | `false` | Also request the display (defeats Modern Standby on battery). Explicit boolean wins over `mode`. |
| `mode` | *(unset)* | Alias: `"system"` => display off, `"display"` => display on. |
| `stallReleaseSeconds` | `1800` | While busy, release the power request if no event at all arrives for this long. `0` disables. |
| `setupMode` | `"detect"` | `detect` (notice only) \| `apply` (opt-in, one UAC prompt) \| `off`. |
| `stateFile` | `~/.config/opencode/keep-awake/setup-state.json` | Where the one-time-notice state is persisted. |

Environment overrides: `KEEP_AWAKE_SETUP` (`off`\|`detect`\|`apply`),
`KEEP_AWAKE_STATE_FILE` (path), and `KEEP_AWAKE_DEBUG_FILE` (append a trace).

Plugin options and config are re-read on an OpenCode hot reload (the shared
config is refreshed), so first-run detection and the new options take effect
without restarting the server. Note: OpenCode V2 can keep the previously loaded
module's event subscription and helper process alive across a reload, so the
currently running helper may be respawned with the previous argv until a full
cold start (or a full teardown/re-setup).

## Test

```bash
node keep-awake/test/keep-awake.test.mjs
```
