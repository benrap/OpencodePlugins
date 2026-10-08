# OpenCode Plugins

A collection of OpenCode V2 plugins, one agent, and a patched-build shim, all
sourced from this repo.

| Item | Type | Description |
| --- | --- | --- |
| [`subagent-abort`](./subagent-abort) | server | Registers the `abort_subagent` tool to interrupt active descendant subagent sessions of the calling session (one named descendant, or every running descendant). |
| [`subagent-message`](./subagent-message) | server | Registers the `message_agent` tool for lineage-scoped agent-to-agent messaging: send to your parent or a direct child only (siblings, non-descendants, and level-skips rejected). Steers an active target, otherwise queues a follow-up. |
| [`subagent-sidebar-tree`](./subagent-sidebar-tree) | TUI | TUI sidebar panel showing live child subagent sessions as a nested tree. |
| [`subagent-status`](./subagent-status) | server | `subagent-status` tool that probes a subagent's state without pulling its raw transcript into the caller's context. Three modes: `state` (lightweight, no LLM call), `summary` (default; adds an LLM summary), and `all` (the name and state of every active subagent, no LLM call). |
| [`keep-awake`](./keep-awake) | server | Keeps a Windows machine awake (display may power off) while any session/agent is busy. Windows-only. |
| [`prefill`](./prefill) | server | Per-message opt-in message injection (assistant prefill / steering) via a trailing `#prefill` marker stripped before persistence. |
| [`always-background`](./always-background) | server | Forces background execution for every tool call **except** `shell` and `subagent` via the `execute.before` hook; the exclude list is configurable. |
| [`patched-opencode`](./patched-opencode) | tooling | Reversible shim that makes `opencode` launch a patched build from source (sidebar `parentID` gate removal, waiting/tick/abort fix, and a child-session inline steer composer), with cumulative patches and switch/revert scripts. |
| [`agents/forced-orchestrator.md`](./agents/forced-orchestrator.md) | agent | Nested-delegation orchestrator; only the `subagent`, `subagent-status`, `subagent-abort`, `message_agent`, `question`, and `skill` tools are allowed, everything else denied. |

## Installation instructions (for AI agents)

Paths below use `%USERPROFILE%` and `<repo-root>` placeholders — substitute
your own. Config root: `~/.config/opencode` (`$env:USERPROFILE\.config\opencode`).

### 1. Register plugins in `~/.config/opencode/opencode.jsonc`

Add entries to the top-level `"plugins"` array. `subagent-abort`,
`subagent-message`, `subagent-sidebar-tree`, and `subagent-status` are
referenced **directly from this checkout** (path-based, no copy step).
`keep-awake`, `always-background`, and `prefill` load from
`~/.config/opencode/plugins/<name>/`, which must contain a **copy** (never a
symlink) of the repo folder.

```jsonc
{
  "plugins": [
    "%USERPROFILE%\\.config\\opencode\\plugins\\keep-awake",
    { "package": "%USERPROFILE%\\.config\\opencode\\plugins\\always-background",
      "options": { "exclude": ["shell", "subagent"] } },
    { "package": "%USERPROFILE%\\.config\\opencode\\plugins\\prefill",
      "options": { "mode": "think-reply-continue", "thinkingSeed": "I should answer...",
                   "seed": "I will give my answer:", "userSeed": "Continue" } },
    { "package": "<repo-root>\\subagent-abort" },
    { "package": "<repo-root>\\subagent-status" },
    { "package": "<repo-root>\\subagent-message" },
    { "package": "<repo-root>\\subagent-sidebar-tree" }
  ]
}
```

Keep each plugin's existing entry (especially `prefill`'s `options` and
`always-background`'s `exclude`) intact when re-registering. If
`always-background` has no `options.exclude`, it defaults to
`["shell", "subagent"]`.

### 2. Refresh a copied plugin

Run from this repo root to copy a plugin into its live dir (repeat per plugin):

```powershell
Copy-Item -Recurse -Force .\keep-awake\* "$env:USERPROFILE\.config\opencode\plugins\keep-awake\"
```

The directly-referenced plugins (`subagent-abort`, `subagent-message`,
`subagent-sidebar-tree`, `subagent-status`) need no copy — editing the checkout
is enough after OpenCode reloads.

### 3. Install the agent

The live agent dir on this host is `~/.config/opencode/agents/` (**plural**;
the host also accepts the singular `agent/`, but only `agents/` exists here).
Copy the definition into it:

```powershell
Copy-Item -Force .\agents\forced-orchestrator.md "$env:USERPROFILE\.config\opencode\agents\forced-orchestrator.md"
```

### 4. Install the patched-openCode shim (optional)

`patched-opencode/` makes the `opencode` command resolve to a patched build run
from source, without touching the stock installation. Apply it with:

```powershell
powershell -ExecutionPolicy Bypass -File .\patched-opencode\scripts\switch-patched.ps1
```

Open a **new** shell and verify (`opencode --version` prints `opencode vlocal`).
Revert with `scripts\revert-patched.ps1`; fresh installs can create the shim dir
with `scripts\install-shim.ps1`. See
[`patched-opencode/README.md`](./patched-opencode/README.md) for the patch
contents, source location, and optional compiled-binary build.

### 5. Run the tests

From `subagent-sidebar-tree/` (the `.mjs` suites are portable):

```bash
node --experimental-strip-types test/subagent-sidebar-tree.test.mjs
node --experimental-strip-types test/subagent-server-safe.test.mjs
node test/tui-jsx-sanity.mjs tui.tsx
```

`subagent-abort` has its own portable suite. From `subagent-abort/`:

```bash
node --experimental-strip-types test/subagent-abort.test.mjs
```

`subagent-message` has its own portable suite. From this repo root:

```bash
node --experimental-strip-types subagent-message/test/subagent-message.test.mjs
node --experimental-strip-types subagent-message/test/subagent-message-server-safe.test.mjs
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

`keep-awake` has its own portable suite:

```bash
node keep-awake/test/keep-awake.test.mjs
```

### 6. Behavior notes

- `subagent-sidebar-tree` adapts to the host: a right-pane panel on stock v2.0.22, the 42-col core sidebar on a patched/ungated build.
- `subagent-abort` registers the `abort_subagent` tool, which interrupts the caller's own descendant subagent sessions (one by `sessionID`, or all with `all: true`) and returns the aborted sessionIDs.
- `subagent-message` registers the `message_agent` tool, which sends a message along a single direct lineage edge only — to the caller's parent or one of its direct children. Siblings, non-descendants, grandchildren, and level-skips to a root are rejected. A running/waiting target is steered; an idle target is queued. Recipients treat inter-agent content as untrusted.
- `subagent-status` defaults to `summary` mode (state + a 2-4 sentence LLM summary). Pass `mode: "state"` for a cheap status check (`running`/`idle`/`waiting`/`finished`) with no LLM call.
- `always-background` forces `background: true` on every tool call except those in its `exclude` list (default `["shell", "subagent"]`, which keep their own user-controlled `background` input).
- `keep-awake` keeps the machine awake but lets the display sleep (`keepDisplayOn`/`mode: "display"` to keep it on).
- `patched-opencode` is a PATH shim, not a plugin: it launches the patched source via `bun run`, so source edits are picked up on the next invocation with no rebuild.

## License

MIT. See [LICENSE](./LICENSE). `subagent-sidebar-tree` is a derivative work based on `@madsoftwaredev/opencode-subagent-sidebar` (MIT); see [`subagent-sidebar-tree/LICENSE`](./subagent-sidebar-tree/LICENSE).
