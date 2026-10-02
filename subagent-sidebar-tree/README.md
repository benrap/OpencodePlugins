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

## Abort active agents

The server entrypoint registers an `abort_subagent` tool. Any agent that can
spawn subagents can abort its own descendants:

- `abort_subagent({ sessionID })` — abort one descendant session.
- `abort_subagent({ all: true })` — abort every running descendant of the
  calling session.

Guards (enforced in `subagent-view.ts`, unit-tested): the root/primary session
is never aborted, self-aborts and siblings are rejected, only descendants of the
caller qualify, and already-terminal sessions are skipped. The tool returns the
aborted `sessionID`s so the caller can continue them later through the `subagent`
tool.

The runtime's plugin context exposes no permission `assert`/`ask` (only
`hook`/`list`/`get`/`reply`), so the capability gate is the lineage gate. If a
future runtime exposes `permission.assert`, it is called with the same action as
subagent spawning (`subagent`, resource = target agent id).

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
live config dir — the three `.mjs` suites resolve plugin sources relative to
the test file):

```bash
node --experimental-strip-types test/subagent-sidebar-tree.test.mjs
node --experimental-strip-types test/subagent-abort.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
node test/tui-jsx-sanity.mjs tui.tsx
```
