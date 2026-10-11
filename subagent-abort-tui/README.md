# subagent-abort-tui

An OpenCode **v2 TUI plugin** that aborts (interrupts) the child/subagent session
you are currently viewing. It adds a **`ctrl+d`** keybind and a **`/abort`** slash
command that both do the same thing: interrupt the viewed subagent.

## What it does

- Adds the keybind command **`subagent.abort`** ("Abort viewed subagent"),
  available in the command palette and as the `/abort` slash command, bound by
  default to **`ctrl+d`**.
- Running it resolves the active route. If you are viewing a **child** session
  (`parentID` truthy) it calls `context.client.session.interrupt({ sessionID,
  resume: false })` and shows an "Aborted subagent" success toast. On failure it
  shows a failure toast.
- It is **child-only**. While a main/root session (no `parentID`) or any
  non-session route is in view the command is **disabled** (not offered in the
  palette, slash command inert) and running it is a no-op — it never touches the
  main session.

## Supported extension points used

| API | Use |
| --- | --- |
| `context.ui.router.current()` | resolve the route; pick the viewed `sessionID` |
| `context.data.session.get(id)` | read `parentID` to confirm it is a child |
| `context.keymap.layer(...)` | register the `subagent.abort` command (mode `global`) |
| `context.client.session.interrupt(...)` | abort the viewed child session |
| `context.ui.toast.show(...)` | report success/failure |

## Install / register

Do **not** edit the global config for the user. To use this plugin, add its path
to the `plugins` array in `~/.config/opencode/opencode.jsonc` (path-based, like
`subagent-steer`):

```jsonc
{
  "plugins": [
    { "package": "<repo-root>\\subagent-abort-tui" }
  ]
}
```

The default shortcut is configurable like any named command:

```jsonc
{
  "keybinds": {
    "subagent.abort": "ctrl+d"
  }
}
```

> **`ctrl+d` stops exiting the app.** OpenCode binds `ctrl+d` to `app.exit` by
> default. This plugin claims `ctrl+d` for `subagent.abort`; to make the new
> binding authoritative override the exit key too:
> `{ "keybinds": { "app.exit": "ctrl+c,<leader>q" } }`.

## Behavior notes

- **Child-only.** On a main/root session (or a non-session screen) `ctrl+d` and
  `/abort` do nothing.
- The interrupt sends `{ sessionID, resume: false }`, matching the v2 runtime
  `session.interrupt` contract.

## Tests

From this folder (portable, no OpenTUI needed):

```bash
node --experimental-strip-types test/subagent-abort-tui.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
```

## Layout

| File | Purpose |
| --- | --- |
| `server.ts` | no-op server entrypoint (must not import TUI packages) |
| `abort.ts` | pure, dependency-free abort-target logic (unit-tested) |
| `tui.tsx` | `Plugin.define({ id, setup })`: the `subagent.abort` command |
| `test/subagent-abort-tui.test.mjs` | portable unit tests |
| `test/subagent-server-safe.test.mjs` | server graph is TUI-free |
