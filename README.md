# OpenCode Plugins

A collection of OpenCode V2 plugins.

| Plugin | Type | Description |
| --- | --- | --- |
| [`subagent-sidebar-tree`](./subagent-sidebar-tree) | server + TUI | TUI sidebar panel that shows live child subagent sessions as a nested tree. |
| [`subagent-status`](./subagent-status) | server | Registers a `subagent-status` tool that probes a subagent's state via an LLM-generated summary of its conversation, without pulling the raw transcript into the caller's context. |
| [`keep-awake`](./keep-awake) | server | Keeps a Windows machine awake (display may power off) while any session/agent is busy. **Windows-only.** |
| [`prefill`](./prefill) | server | Per-message opt-in message injection (assistant prefill / conversation steering) via a trailing `#prefill` marker that is stripped before persistence. |
| [`always-background`](./always-background) | server | Actively forces background execution for `shell` and `subagent` tool calls via the `execute.before` hook. |

**Type** comes from the `oc-plugin` field in each plugin's `package.json`:
`subagent-sidebar-tree` declares `["server", "tui"]` and `subagent-status`
declares `["server"]`. The three older plugins (`always-background`,
`keep-awake`, `prefill`) are dependency-free server-side plain-object plugins
(`export default { id, setup }`) that predate the `oc-plugin` field, so it is
absent from their `package.json`; their type is inferred from the hooks they
register.

## Install

Each folder is a self-contained OpenCode V2 plugin. Install one from a local
checkout with `opencode plugin add`, or reference its path in your
`opencode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "./OpencodePlugins/prefill" }
  ]
}
```

See each plugin's README for its own options and usage notes.

## Agents

`agents/forced-orchestrator.md` is an OpenCode **agent** definition, not a
plugin. It is a nested-delegation orchestrator with no tools of its own except
the `subagent` tool, plus `question` and `skill`; every other capability (read,
edit, shell, web, search, glob, grep) is denied via a deny-all-then-allow
permissions list. It restates the task and acceptance criteria, decomposes the
task into independent subtasks, launches child subagents in parallel (for
example `explore` for read-only reconnaissance and `general` for multi-step
work), has a separate child verify correctness where it matters, and reports
back with evidence. It is configured with `mode: all`.

## Repository layout and live copies

This repository is the **single source of truth** for the plugins. All plugin
projects live together in this one folder, both locally and on GitHub
(`<repo-root>\<plugin>\`).

- **Canonical source:** this git repo. Edit, test, commit and push here.
- **Registration:** all plugins are registered in the `"plugins"` array of
  `~/.config/opencode/opencode.jsonc`. (`~/.config/opencode/cli.json` also
  exists, but it holds only TUI display preferences — diffs, sidebar, thinking,
  animations — and does **not** register any plugins.)
- **How each plugin is loaded:**
  - **Referenced directly from this checkout (no copy step):**
    `subagent-status` and `subagent-sidebar-tree` are registered with their repo
    paths, e.g.
    `{ "package": "<repo-root>\\subagent-status" }`.
    Editing the repo copy changes the live plugin once OpenCode reloads it.
  - **Copied into the live config dir:** `keep-awake`, `always-background`, and
    `prefill` are loaded from
    `%USERPROFILE%\.config\opencode\plugins\<plugin>\`. Those folders are
    **copies — never symlinks or junctions** — of the repo folders. Refresh a
    live copy from the checkout, for example:

    ```powershell
    Copy-Item -Recurse -Force .\keep-awake\* `
      "$env:USERPROFILE\.config\opencode\plugins\keep-awake\"
    ```

    `prefill` is registered with options, so keep its entry in
    `opencode.jsonc` intact when refreshing the copy.
- **Workflow:** while a change is in progress, create a git worktree on a
  throwaway branch and copy from that worktree into the live dir to test it
  live. Once the change is merged to `main`, copy from `main` (the canonical
  tree) — the live dirs are disposable consumers of the repo, not sources. For
  the directly-referenced plugins there is no copy step; point them at the
  worktree or the canonical tree as needed.

### Running the tests

Tests live in `subagent-sidebar-tree/test/`:

| File | Purpose |
| --- | --- |
| `subagent-sidebar-tree.test.mjs` | Core tree/state logic unit tests. |
| `subagent-abort.test.mjs` | Abort-targeting and registry tests. |
| `subagent-server-safe.test.mjs` | Asserts `server.ts` imports with no OpenTUI/Solid/TUI in its resolution graph. |
| `tui-jsx-sanity.mjs` | Structural sanity check for `tui.tsx` (brace/JSX balance; no toolchain needed). |
| `subagent-sidebar-visibility.test.tsx` | OpenTUI render test for the sidebar tree; run through `run-visibility-test.mjs`. |
| `run-visibility-test.mjs` | Copies sources into a temp harness, links OpenTUI `node_modules`, runs `bun test`. |
| `diagnose-overlay.test.tsx` | Layout diagnostic for the sidebar; run through `run-diagnose-overlay.mjs`. |
| `run-diagnose-overlay.mjs` | Temp-harness runner for the overlay diagnostic. |

From the `subagent-sidebar-tree` folder (the `.mjs` suites resolve plugin
sources relative to the test file, so they are portable across the repo, a
worktree, and a copied live dir):

```bash
node --experimental-strip-types test/subagent-sidebar-tree.test.mjs
node --experimental-strip-types test/subagent-abort.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
node test/tui-jsx-sanity.mjs tui.tsx
```

The two `bun`-based runners need an OpenTUI `node_modules` (containing
`@opentui/core`, `@opentui/solid`, and `solid-js`). They default to a local
OpenCode checkout and can be redirected with the `OPENTUI_NODE_MODULES`
environment variable:

```bash
node test/run-visibility-test.mjs
node test/run-diagnose-overlay.mjs
```

## License

MIT. See [LICENSE](./LICENSE) for the repository license.
`subagent-sidebar-tree` is a derivative work based on
`@madsoftwaredev/opencode-subagent-sidebar` (MIT); see
[`subagent-sidebar-tree/LICENSE`](./subagent-sidebar-tree/LICENSE) and its
README for the upstream attribution.
