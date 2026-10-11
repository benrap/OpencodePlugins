# subagent-abort-tui

An OpenCode **v2 TUI plugin** that aborts (interrupts) the child/subagent session
you are currently viewing **and all of its descendant subagents, recursively**.
It adds a **`ctrl+d`** keybind and a **`/abort`** slash command that both do the
same thing: interrupt the viewed subagent's whole subtree.

## What it does

- Adds the keybind command **`subagent.abort`** ("Abort viewed subagent"),
  available in the command palette and as the `/abort` slash command, bound by
  default to **`ctrl+d`**.
- Running it resolves the active route. If you are viewing a **child** session
  (`parentID` truthy) it collects the **subtree** — the viewed session plus every
  descendant, enumerated recursively through
  `context.client.session.list({ parentID })` — and interrupts each id. It then
  shows a single success toast with the count (e.g. `Aborted 3 subagents`). On
  failure it shows a failure toast.
- The interrupts are issued **descendants-first** (the viewed session is aborted
  last), so a child that is holding a `waiting` parent open is stopped before its
  parent.
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
| `context.client.session.list({ parentID })` | enumerate the subtree, recursively (cycle-safe, depth-capped) |
| `context.client.session.interrupt(...)` | abort each session in the subtree (descendants first) |
| `context.ui.toast.show(...)` | report one success/failure toast |

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
- **Recursive.** The subtree is the viewed session plus every descendant,
  enumerated breadth-first through `context.client.session.list({ parentID })`.
  A cycle/duplicate `parentID` cannot loop forever and expansion is capped at
  `MAX_SUBTREE_DEPTH` (16) levels.
- **Order.** Interrupts run descendants-first (reverse breadth-first), so the
  viewed session is aborted last.
- The interrupt sends `{ sessionID, resume: false, cancelBackground: true }`.
  `cancelBackground` is a new `session.interrupt` field (core patch **`0005`**)
  that also cancels the session's outstanding durable background jobs, so a
  session parked in `waiting` actually stops. It is passed even though the
  plugin's bundled type definitions may not list the field yet.

## Tests

From this folder (portable, no OpenTUI needed):

```bash
node --experimental-strip-types test/subagent-abort-tui.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
```

The first suite drives `abortSubtree` with a MOCK client: it asserts the exact
flat set of ids interrupted for a `child -> grandchild1, grandchild2 ->
great-grandchild` tree, that every interrupt carries
`{ sessionID, resume: false, cancelBackground: true }`, that the viewed session
is aborted last, and that a cyclic/duplicate lineage terminates without looping
or duplicating ids (`28 checks passed`).

## Layout

| File | Purpose |
| --- | --- |
| `server.ts` | no-op server entrypoint (must not import TUI packages) |
| `abort.ts` | pure, dependency-free abort logic: subtree collection, ordering, interrupt-call construction, toast (unit-tested) |
| `tui.tsx` | `Plugin.define({ id, setup })`: the `subagent.abort` command |
| `test/subagent-abort-tui.test.mjs` | portable unit tests |
| `test/subagent-server-safe.test.mjs` | server graph is TUI-free |
