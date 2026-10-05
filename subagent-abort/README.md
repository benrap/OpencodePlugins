# subagent-abort

An OpenCode **server-side** plugin that registers ONE tool, `abort_subagent`,
which interrupts the active execution of descendant subagent sessions the
calling session spawned.

> **Attribution.** The abort logic and the pure helper functions it depends on
> were extracted from
> [`subagent-sidebar-tree`](../subagent-sidebar-tree), itself a modified
> derivative of
> [`@madsoftwaredev/opencode-subagent-sidebar`](https://github.com/madsoftwaredev/opencode-plugins)
> (MIT). The upstream copyright notice is preserved in [`LICENSE`](./LICENSE)
> (Copyright (c) 2026 MadSoftwareDev). This is not the original work.

## Features

- Aborts ONE named descendant: `abort_subagent({ sessionID })`.
- Aborts EVERY running descendant of the caller: `abort_subagent({ all: true })`.
- Returns the aborted `sessionID`s so the caller can continue them later through
  the `subagent` tool with that sessionID.
- Process-wide session registry fed by the host event stream, so activity and
  lineage are tracked without a `session.list` API.

## How it works

OpenCode V2 loads a plugin's server side independently of the TUI. This plugin
is server-only (`oc-plugin: ["server"]`) and its files import nothing outside
the folder — no `@opentui/*`, no `solid-js`, no `@opencode/plugin`.

1. **Registration.** `server.ts` calls `installAbortTool(ctx)`. When
   `ctx.tool.transform` exists, it registers a single tool definition via
   `ctx.tool.transform((editor) => editor.add({ ... }))`. With no context (or a
   context lacking `tool.transform`) it is a harmless no-op, so host startup can
   never break.

2. **Registry.** A process-wide registry, keyed by
   `Symbol.for("opencode.subagent-abort.registry.v1")`, survives the host
   re-evaluating the module. `installAbortTool` subscribes once to
   `ctx.event.subscribe` and folds `session.created` / `session.execution.*` /
   `session.status` / `session.updated` events into a `Map<sessionID, record>`
   plus an active-session `Set`. Malformed events are ignored, never thrown.

3. **Execution.** On each call the tool resolves the caller session and the
   target lineage (live via `ctx.session.get`, falling back to the registry),
   selects running descendants, re-checks the guards, honours a permission gate
   if a future runtime exposes one, then calls
   `ctx.session.interrupt({ sessionID, resume: false })` (with defensive
   fallbacks). Per-target failures are reported in the result rather than
   thrown.

## Usage

```jsonc
// abort one descendant subagent
abort_subagent({ sessionID: "ses_abc123" })
```

```jsonc
// abort every running descendant of the calling session
abort_subagent({ all: true })
```

Result payload (JSON string):

```json
{ "aborted": ["ses_abc123"], "failures": [] }
```

Each failure is `{ "sessionID": "...", "reason": "...", "message"?: "..." }`.

### Parameters

| Name        | Type    | Description                                            |
| ----------- | ------- | ------------------------------------------------------ |
| `sessionID` | string  | Session id of a descendant subagent to abort.          |
| `all`       | boolean | Abort every running descendant of the calling session. |

`additionalProperties` is `false`; pass `sessionID`, `all`, or both.

## Guards

Enforced in `subagent-view.ts` and unit-tested:

- The root/primary session is **never** aborted.
- Self-aborts and siblings are rejected.
- Only descendants of the calling session qualify.
- Already-terminal sessions are skipped.
- The caller session must be determinable.

## Install

Add the package path to `opencode.jsonc`:

```jsonc
{ "plugins": [{ "package": "C:\\Users\\benrap\\CodeProjects\\OpencodePlugins\\subagent-abort" }] }
```

## Tests

Requires Node.js >= 22 (uses `--experimental-strip-types` to run the TypeScript
module directly). Run from this plugin folder:

```bash
node --experimental-strip-types test/subagent-abort.test.mjs
```

The suite prints `41 checks passed`.
