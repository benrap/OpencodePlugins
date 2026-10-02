# OpenCode Plugins

A collection of OpenCode V2 plugins.

| Plugin | Description |
| --- | --- |
| [`subagent-sidebar-tree`](./subagent-sidebar-tree) | TUI sidebar panel that shows live child subagent sessions as a nested tree. |
| [`keep-awake`](./keep-awake) | Keeps a Windows machine awake (display may power off) while any session/agent is busy. **Windows-only.** |
| [`prefill`](./prefill) | Per-message opt-in message injection (assistant prefill / conversation steering) via a trailing `#prefill` marker. |
| [`always-background`](./always-background) | Forces background execution for `shell` and `subagent` tool calls. |

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

## Repository layout and live copies

This repository is the **single source of truth** for the plugins. All plugin
projects live together in this one folder, both locally and on GitHub
(`<repo-root>\<plugin>\`).

- **Canonical source:** this git repo. Edit, test, commit and push here.
- **Live config:** OpenCode loads plugins from
  `%USERPROFILE%\.config\opencode\plugins\<plugin>\`. Those folders are
  **copies — never symlinks or junctions** — of the repo folders. Refresh a
  live plugin by copying from the checkout, for example:

  ```powershell
  Copy-Item -Recurse -Force .\subagent-sidebar-tree\* `
    "$env:USERPROFILE\.config\opencode\plugins\subagent-sidebar-tree\"
  ```

- **Workflow:** while a change is in progress, create a git worktree on a
  throwaway branch and copy from that worktree into the live dir to test it
  live. Once the change is merged to `main`, copy from `main` (the canonical
  tree) — the live dirs are disposable consumers of the repo, not sources.
- **Registration:** `subagent-sidebar-tree` is registered in
  `~/.config/opencode/cli.json` (TUI plugin list); `keep-awake`,
  `always-background` and `prefill` (with options) are registered in
  `~/.config/opencode/opencode.jsonc`.
- **Note:** the runtime may normalize a copied `package.json` (it has been
  observed adding `"private": true` and dropping `author`/`repository` for a
  locally-referenced plugin). That is expected; the repo copy stays canonical
  and such differences are not treated as drift.

### Running the tests

From a plugin folder (portable across the repo, a worktree, and a copied live
dir, since the `.mjs` suites resolve plugin sources relative to the test file):

```bash
cd subagent-sidebar-tree
node --experimental-strip-types test/subagent-sidebar-tree.test.mjs
node --experimental-strip-types test/subagent-abort.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
node test/tui-jsx-sanity.mjs tui.tsx
```

## License

MIT. See [LICENSE](./LICENSE) for the repository license.
`subagent-sidebar-tree` is a derivative work based on
`@madsoftwaredev/opencode-subagent-sidebar` (MIT); see
[`subagent-sidebar-tree/LICENSE`](./subagent-sidebar-tree/LICENSE) and its
README for the upstream attribution.
