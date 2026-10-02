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

```bash
node --experimental-strip-types test/subagent-sidebar-tree.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
node test/tui-jsx-sanity.mjs subagent-sidebar-tree/tui.tsx
```
