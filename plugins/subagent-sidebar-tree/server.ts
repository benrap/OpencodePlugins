/**
 * subagent-sidebar-tree — server entrypoint (no-op).
 *
 * The sidebar tree is a TUI-only feature contributed by `tui.tsx`. This server
 * entrypoint exists only to satisfy `oc-plugin: ["server", "tui"]`; it must stay
 * free of `@opentui/*`, `solid-js` and any `./tui.*` import so the server can
 * resolve it where those packages are absent. `setup()` is a harmless no-op.
 */
export default {
  id: "subagent-sidebar-tree",
  setup() {
    /* no-op: server side registers nothing */
  },
}
