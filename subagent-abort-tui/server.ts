/**
 * subagent-abort-tui — server entrypoint (no-op).
 *
 * Aborting the viewed subagent is a TUI-only feature contributed by `tui.tsx`.
 * This server entrypoint exists only to satisfy `oc-plugin: ["server", "tui"]`;
 * it must stay free of `@opentui/*`, `solid-js` and any `./tui.*` import so the
 * server can resolve it where those packages are absent. `setup()` is a
 * harmless no-op.
 */
export default {
  id: "subagent-abort-tui",
  setup() {
    /* no-op: server side registers nothing */
  },
}
