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
    { "package": "./OpenCodePlugins/prefill" }
  ]
}
```

See each plugin's README for its own options and usage notes.

## License

MIT. See [LICENSE](./LICENSE) for the repository license.
`subagent-sidebar-tree` is a derivative work based on
`@madsoftwaredev/opencode-subagent-sidebar` (MIT); see
[`subagent-sidebar-tree/LICENSE`](./subagent-sidebar-tree/LICENSE) and its
README for the upstream attribution.
