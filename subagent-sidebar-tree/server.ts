/**
 * subagent-sidebar-tree — server entrypoint.
 *
 * OpenCode V2 loads the server side of a plugin independently of the TUI. This
 * module must stay free of `@opentui/*`, `solid-js` and any `./tui.*` import so
 * the server can resolve it in an environment where those packages are absent.
 *
 * It is a no-op: the sidebar is a TUI-only feature. Plain object plugin (same
 * shape as the other locally proven server plugins) keeps the plugin state
 * "active" without registering any server hooks.
 */
export default {
  id: "subagent-sidebar-tree",
  setup() {},
}
