# subagent-sidebar-tree

An OpenCode V2 TUI plugin that shows live **child subagent sessions** in the
sidebar as a nested tree.

> **Based on [`@madsoftwaredev/opencode-subagent-sidebar`](https://github.com/madsoftwaredev/opencode-plugins) (MIT).**
> This is a modified derivative. The original copyright notice is preserved in
> [`LICENSE`](./LICENSE) (Copyright (c) 2026 MadSoftwareDev). This fork is not
> the original work and does not claim sole authorship.

## Features

- Nested tree of descendant subagent sessions with Unicode box-drawing
  connectors (`├─`, `└─`, `│`), sorted by most-recent activity.
- Per-agent colors with a deterministic fallback palette, plus status labels
  (`running`, `done`, `failed`, `stopped`).
- Two-line rows: session label + status on the first line, task/title preview on
  the second.
- Running sessions are always visible; finished sessions linger briefly
  (60s window); running descendants keep their finished ancestors visible so the
  tree stays connected.
- Collapsible: shows up to 8 subagents inline with a `+N more` expander and a
  scrollable expanded view.
- Click a row to open that subagent session.

## Install

```bash
opencode plugin add ./subagent-sidebar-tree
```

Or reference the path in `opencode.jsonc`:

```jsonc
{ "plugins": [{ "package": "./subagent-sidebar-tree" }] }
```

The plugin exposes a no-op `server` entrypoint and the `tui` entrypoint declared
in `package.json` (`oc-plugin: ["server", "tui"]`).

## Tests

Requires Node.js >= 22 (uses `--experimental-strip-types` to run the TypeScript
module directly):

Run from this plugin folder (works in the repo, a git worktree, or a copied
live config dir — the two `.mjs` suites resolve plugin sources relative to
the test file):

```bash
node --experimental-strip-types test/subagent-sidebar-tree.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
node test/tui-jsx-sanity.mjs tui.tsx
```

### Visibility test

`test/subagent-sidebar-visibility.test.tsx` renders the real `SubagentSidebar`
component through the OpenTUI test renderer inside a reproduction of the core
app/session-frame layout, and asserts that the sidebar is actually visible: it
is a flex sibling pinned to the right edge at the sidebar width and full height,
contains the subagent family tree, and does not cover the main or bottom panel
(which are resized to make room). It also asserts that a root session renders the
tree in the sidebar as well.

It needs the OpenTUI packages. Run the self-contained runner, which copies the
plugin sources into a throwaway harness, links `node_modules` at a checkout
that has `@opentui/core`, `@opentui/solid` and `solid-js`, runs the test, and
cleans up:

```bash
node test/run-visibility-test.mjs
```

Set `OPENTUI_NODE_MODULES` to that `node_modules` path if the default is wrong.
The runner deliberately keeps the live plugin folder free of `node_modules`, so
it cannot change how the running TUI resolves the plugin's imports.

## How the sidebar is shown for subagents

The core TUI renders its `Sidebar` — and therefore the `sidebar.content` slot —
for every session, including subagents. The sidebar is laid out as a flex
sibling of the session pane, so the host resizes the main panel to make room for
it. The plugin contributes the subagent family tree to `sidebar.content`, so the
tree appears in the right pane without covering the main or bottom panels. The
whole family (the root's descendants: parent, siblings and children of the
current session) is shown, so the user sees where they are in the tree.

An earlier revision rendered an absolutely-positioned overlay from the `app` slot
to work around a host that gated the sidebar off for `parentID` sessions. That
gate is gone, so the overlay only covered the main panel (or the core sidebar)
and has been removed in favour of contributing to `sidebar.content`.
