# subagent-steer

An OpenCode **v2 TUI plugin** that lets you send a steering message to the
child/subagent session you are currently viewing.

## The gap this fills

In OpenCode v2.0.22/23 the host **hides its own message prompt for child
sessions**. In `packages/tui/src/routes/session/index.tsx` the composer is
forced open for any session with a `parentID` and the normal `<Prompt>` is
replaced with `{null}`:

```
1458:  open={composer.open || (!!session()?.parentID && forms().length === 0)}
1472:  <Match when={composer.open || (!!session()?.parentID && forms().length === 0)}>{null}</Match>
```

The backend already supports steering (prompt delivery defaults to `"steer"`),
so the only thing missing is a TUI affordance to type a steer for the child you
are viewing. This plugin adds one.

## What it does

- Adds a keybind command **`subagent.steer`** ("Steer viewed subagent"),
  available in the command palette and as the `/steer` slash command, bound by
  default to **`ctrl+shift+s`**.
- Running it resolves the active route. If you are viewing a **child** session
  (`parentID` truthy) it opens a prompt dialog ("Steer subagent"). On Enter the
  message is sent to that child via `context.client.session.prompt(...)`. If you
  are **not** viewing a subagent it shows a "Not viewing a subagent" toast and
  does nothing.
- Contributes a small, non-focusable hint above the composer — `Steer this
  subagent: ctrl+shift+s` — but only while the viewed session is a child, so the
  affordance is discoverable.

## Supported extension points used

| API | Use |
| --- | --- |
| `context.ui.router.current()` | resolve the route; pick the viewed `sessionID` |
| `context.data.session.get(id)` | read `parentID` to confirm it is a child |
| `context.keymap.layer(...)` | register the `subagent.steer` command (mode `global`) |
| `context.ui.dialog.prompt(...)` | collect the steer text (modal, focus-safe) |
| `context.ui.toast.show(...)` | report "Not viewing a subagent" |
| `context.ui.slot({ prepend: "session.composer.top", render })` | the hint |
| `context.client.session.prompt(...)` | send the steer |

## Why a keybind + dialog (not an inline slot input)

The preferred design was a focusable single-line `<input>` in the
`session.composer.top` slot that submits on Enter. That is **not achievable with
the supported plugin API** on v2.0.23:

1. For every child session the host forces its composer open — which pushes the
   mutually-exclusive keymap mode `"composer"`:
   `routes/session/composer/index.tsx:63-67` (priority 1, `enabled: () => open`).
2. In that mode the host binds exactly the keys an inline input needs:
   - `config/keybind.ts:247` — `composer.subagent.select: "return"` (Enter)
   - `config/keybind.ts:245-246` — `composer.subagent.up/down: "up"/"down"`
   - `routes/session/composer/index.tsx:83` — `escape` closes the composer
3. The host keymap is registered with `renderer.keyInput.prependListener`
   (`@opentui/keymap/src/opentui.js:69-74`), so command bindings see a key
   **before** the focused renderable's `handleKeyPress`, and a matched binding
   consumes it. A slot `<input>` therefore receives printable characters but
   **not Enter** — pressing Enter would navigate to the selected subagent
   instead of submitting the steer.

`context.ui.dialog.prompt(...)` sidesteps this entirely: the dialog runs in the
host's modal scope with its own focused textarea, and its Enter is bound to
`dialog.prompt.submit` (`config/keybind.ts:264`), so typing and submission work
regardless of the composer.

## Install / register

Do **not** edit the global config for the user. To use this plugin, add its path
to the `plugins` array in `~/.config/opencode/opencode.jsonc` (path-based, like
`subagent-sidebar-tree`):

```jsonc
{
  "plugins": [
    { "package": "<repo-root>\\subagent-steer" }
  ]
}
```

The default shortcut is configurable like any named command:

```jsonc
{
  "keybinds": {
    "subagent.steer": "ctrl+shift+s"
  }
}
```

## Known limitations

- **The host composer stays hidden for children.** This plugin does not restore
  the host `<Prompt>`; it adds an out-of-band steer affordance instead.
- **The steer prompt payload shape is `{ sessionID, parts: [{ type: "text",
  text }] }`.** The plugin-facing API for `@opencode/plugin@2.0.12` is written
  this way, but the v2.0.23 runtime client (`context.client`, wired at
  `packages/tui/src/plugin/api.tsx:159` to the raw API) accepts
  `{ sessionID, text, ... }` — see
  `packages/client/src/promise/generated/client.ts:713-727`,
  `packages/client/src/promise/generated/types.ts:4150`, and
  `packages/schema/src/prompt-input.ts:29`. If the live build rejects `parts`,
  `steer.ts` is the single place to change (send `{ sessionID, text }`).
- Steering targets only the **child you are viewing**; there is no "send to
  main" shortcut.

## Tests

From this folder (portable, no OpenTUI needed):

```bash
node --experimental-strip-types test/subagent-steer.test.mjs
```

OpenTUI render test for the hint (needs a `node_modules` with `@opentui/*`,
`solid-js` and `@opencode/plugin`):

```bash
OPENTUI_NODE_MODULES=<path-to-node_modules> node test/run-hint-test.mjs
```

## Layout

| File | Purpose |
| --- | --- |
| `server.ts` | no-op server entrypoint (must not import TUI packages) |
| `steer.ts` | pure, dependency-free steering logic (unit-tested) |
| `tui.tsx` | `Plugin.define({ id, setup })`: hint slot + `subagent.steer` command |
| `test/subagent-steer.test.mjs` | portable unit tests |
| `test/steer-hint.test.tsx` / `test/run-hint-test.mjs` | OpenTUI render harness |
