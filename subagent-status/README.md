# subagent-status

An OpenCode V2 plugin that registers a `subagent-status` tool. It lets a
parent agent probe a subagent's state WITHOUT pulling the subagent's raw
transcript into its own context.

## How it works

The tool reads the target session's recent conversation and returns a summary.
It supports two modes:

- **`state`** — Returns only the session state (`running`, `idle`, `waiting`,
  or `finished`) without making an LLM call. This is a lightweight status
  check.
- **`summary`** (default) — Returns the state AND an LLM-generated 2-4
  sentence summary of what the subagent is doing, its status, key findings,
  blockers, and the likely next step.

## Usage

```js
// Lightweight status check (no LLM call)
const { output } = await tools.subagent-status.state({ sessionID: "ses_xxx" });
// output.state === "running" | "idle" | "waiting" | "finished"

// Full summary (includes state + LLM summary)
const { output } = await tools.subagent-status.summary({ sessionID: "ses_xxx" });
// output.state === "running" | ...
// output.summary === "The subagent is currently..."
```

## Parameters

| Parameter  | Type     | Default     | Description                                                                 |
| ---------- | -------- | ----------- | --------------------------------------------------------------------------- |
| `sessionID` | `string` | (required)  | Session id of the subagent to check.                                        |
| `mode`     | `string` | `"summary"` | `"state"` for a lightweight status check, `"summary"` for the full summary. |
| `limit`    | `integer` | `20`        | How many recent messages to read (max 200).                                 |
| `model`    | `string` | —           | Optional model override as `"providerID/modelID"`.                         |

## Output

| Field       | Type     | Description                                              |
| ----------- | -------- | -------------------------------------------------------- |
| `sessionID` | `string` | The session id that was queried.                         |
| `state`     | `string` | `running`, `idle`, `waiting`, or `finished`.             |
| `summary`   | `string` | LLM-generated summary (only in `summary` mode).          |
| `error`     | `string` | Error message (only on failure).                         |

## Install

```bash
opencode plugin add ./subagent-status
```

Or reference the path in `opencode.jsonc`:

```jsonc
{ "plugins": [{ "package": "./subagent-status" }] }
```
