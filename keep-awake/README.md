# keep-awake

An OpenCode V2 plugin that keeps a **Windows** machine awake (no sleep; the
display may still power off) while any OpenCode session/agent is busy.

**Windows-only.** On non-Windows hosts the plugin is a harmless no-op.

## How it works

The plugin subscribes to the OpenCode event stream. On
`session.execution.started` it spawns `keep-awake.ps1`, which acquires a Windows
Power Request (`PowerRequestExecutionRequired` + `PowerRequestSystemRequired`);
the display is deliberately *not* requested. When the busy sessions finish, the
helper process is released (with a short debounce). The helper:
- uses an exclusive named mutex so at most one helper holds the power request
  across all OpenCode processes;
- falls back to `SetThreadExecutionState` when the Power Request API is
  unavailable;
- exits on its own if the parent process dies or `maxSeconds` elapses.

## Install

```bash
opencode plugin add ./keep-awake
```

Or reference the path in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "./keep-awake", "options": { "releaseDelayMs": 1500, "maxSeconds": 43200 } }
  ]
}
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `releaseDelayMs` | `1500` | Debounce before releasing the helper once no session is busy. |
| `maxSeconds` | `43200` | Safety valve: helper exits after this many seconds. |
| `debug` | `false` | Verbose logging. |

Diagnostics can also be written by setting the `KEEP_AWAKE_DEBUG_FILE`
environment variable to a file path.
