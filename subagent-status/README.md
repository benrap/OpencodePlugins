# subagent-status

An OpenCode V2 plugin that registers a `subagent-status` tool. It lets a
parent agent probe a subagent's state WITHOUT pulling the subagent's raw
transcript into its own context.

## How it works

The tool reads the target session's recent conversation and returns a summary.
It supports three modes:

- **`state`** (default) — Returns only the session state (`running`, `idle`,
  `waiting`, or `finished`) without making an LLM call. This is a lightweight
  status check.
- **`summary`** — Returns the state AND an LLM-generated 2-4 sentence summary
  of what the subagent is doing, its status, key findings, blockers, and the
  likely next step.
- **`all`** — Returns the NAME and STATE of every ACTIVE subagent (state is
  exactly `running` or `waiting`). It needs **no `sessionID`** and makes **no
  LLM call**. The inventory comes from the host event stream, scoped
  process-wide; root/primary sessions (which have no parent) are excluded, as
  are finished/idle sessions.

## Usage

```js
// Lightweight status check (no LLM call)
const { output } = await tools.subagent-status.state({ sessionID: "ses_xxx" });
// output.state === "running" | "idle" | "waiting" | "finished"

// Full summary (includes state + LLM summary)
const { output } = await tools.subagent-status.summary({ sessionID: "ses_xxx" });
// output.state === "running" | ...
// output.summary === "The subagent is currently..."

// List every active (running/waiting) subagent — no sessionID needed
const { output } = await tools.subagent-status.all({});
// output.subagents === [{ name: "explore", state: "running", sessionID: "ses_yyy" }, ...]
// output.count === 2
```

## Parameters

| Parameter  | Type     | Default     | Description                                                                 |
| ---------- | -------- | ----------- | --------------------------------------------------------------------------- |
| `sessionID` | `string` | (required)  | Session id of the subagent to check. Required for `state`/`summary`; ignored by `all`. |
| `mode`     | `string` | `"state"`   | `"state"` for a lightweight status check, `"summary"` for the full summary, `"all"` for the active-subagent list. |
| `limit`    | `integer` | `20`        | How many recent messages to read (max 200).                                 |
| `model`    | `string` | —           | Optional model override as `"providerID/modelID"`.                         |

## Output

| Field       | Type     | Description                                              |
| ----------- | -------- | -------------------------------------------------------- |
| `sessionID` | `string` | The session id that was queried.                         |
| `state`     | `string` | `running`, `idle`, `waiting`, or `finished`.             |
| `summary`   | `string` | LLM-generated summary (only in `summary` mode).          |
| `subagents` | `array`  | Active subagents `{ name, state, sessionID }` (only in `all` mode). |
| `count`     | `integer` | Number of active subagents (only in `all` mode).        |
| `error`     | `string` | Error message (only on failure).                         |

In `all` mode an empty result returns `{ subagents: [], count: 0 }` (and the
content `No active subagents.`). The list is populated from the host event
stream and is scoped process-wide; only subagents with a parent whose state is
`running` or `waiting` are included.

## Install

```bash
opencode plugin add ./subagent-status
```

Or reference the path in `opencode.jsonc`:

```jsonc
{ "plugins": [{ "package": "./subagent-status" }] }
```
