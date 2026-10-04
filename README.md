# OpenCode Plugins

A collection of OpenCode V2 plugins plus one agent, all sourced from this repo.

| Item | Type | Description |
| --- | --- | --- |
| [`subagent-sidebar-tree`](./subagent-sidebar-tree) | server + TUI | TUI sidebar panel showing live child subagent sessions as a nested tree. |
| [`subagent-status`](./subagent-status) | server | `subagent-status` tool that probes a subagent's state via an LLM summary without pulling its raw transcript into the caller's context. |
| [`keep-awake`](./keep-awake) | server | Keeps a Windows machine awake (display may power off) while any session/agent is busy. Windows-only. |
| [`prefill`](./prefill) | server | Per-message opt-in message injection (assistant prefill / steering) via a trailing `#prefill` marker stripped before persistence. |
| [`always-background`](./always-background) | server | Forces background execution for `shell` and `subagent` tool calls via the `execute.before` hook. |
| [`agents/forced-orchestrator.md`](./agents/forced-orchestrator.md) | agent | Nested-delegation orchestrator; only the `subagent`, `question`, and `skill` tools are allowed, everything else denied. |

## Installation instructions (for AI agents)

All paths below are real on this host. Config root: `~/.config/opencode` (`$env:USERPROFILE\.config\opencode`).

### 1. Register plugins in `~/.config/opencode/opencode.jsonc`

Add entries to the top-level `"plugins"` array. `subagent-sidebar-tree` and
`subagent-status` are referenced **directly from this checkout** (path-based, no
copy step). `keep-awake`, `always-background`, and `prefill` load from
`~/.config/opencode/plugins/<name>/`, which must contain a **copy** (never a
symlink) of the repo folder.

```jsonc
{
  "plugins": [
    "%USERPROFILE%\\.config\\opencode\\plugins\\keep-awake",
    "%USERPROFILE%\\.config\\opencode\\plugins\\always-background",
    { "package": "%USERPROFILE%\\.config\\opencode\\plugins\\prefill",
      "options": { "mode": "think-reply-continue", "thinkingSeed": "I should answer...",
                   "seed": "I will give my answer:", "userSeed": "Continue" } },
    { "package": "<repo-root>\\subagent-status" },
    { "package": "<repo-root>\\subagent-sidebar-tree" }
  ]
}
```

Keep each plugin's existing entry (especially `prefill`'s `options`) intact when
re-registering.

### 2. Refresh a copied plugin

Run from this repo root to copy a plugin into its live dir (repeat per plugin):

```powershell
Copy-Item -Recurse -Force .\keep-awake\* "$env:USERPROFILE\.config\opencode\plugins\keep-awake\"
```

The directly-referenced plugins (`subagent-sidebar-tree`, `subagent-status`)
need no copy — editing the checkout is enough after OpenCode reloads.

### 3. Install the agent

The live agent dir on this host is `~/.config/opencode/agents/` (**plural**;
the host also accepts the singular `agent/`, but only `agents/` exists here).
Copy the definition into it:

```powershell
Copy-Item -Force .\agents\forced-orchestrator.md "$env:USERPROFILE\.config\opencode\agents\forced-orchestrator.md"
```

### 4. Run the tests

From `subagent-sidebar-tree/` (the `.mjs` suites are portable):

```bash
node --experimental-strip-types test/subagent-sidebar-tree.test.mjs
node --experimental-strip-types test/subagent-abort.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
node test/tui-jsx-sanity.mjs tui.tsx
```

The bun harness runners copy sources into a temp dir, link OpenTUI
`node_modules`, run `bun test`, and clean up. Point `OPENTUI_NODE_MODULES` at a
`node_modules` containing `@opentui/core`, `@opentui/solid`, and `solid-js` if
the default is wrong:

```bash
node test/run-visibility-test.mjs
node test/run-diagnose-overlay.mjs
node test/run-unified-test.mjs
node test/run-panel-test.mjs
```

### 5. Behavior notes

- `subagent-sidebar-tree` adapts to the host: a right-pane panel on stock v2.0.22, the 42-col core sidebar on a patched/ungated build.
- `keep-awake` keeps the machine awake but lets the display sleep (`keepDisplayOn`/`mode: "display"` to keep it on).

## License

MIT. See [LICENSE](./LICENSE). `subagent-sidebar-tree` is a derivative work based on `@madsoftwaredev/opencode-subagent-sidebar` (MIT); see [`subagent-sidebar-tree/LICENSE`](./subagent-sidebar-tree/LICENSE).
