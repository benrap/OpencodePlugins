/**
 * subagent-sidebar-tree — server entrypoint.
 *
 * OpenCode V2 loads the server side of a plugin independently of the TUI. This
 * module must stay free of `@opentui/*`, `solid-js` and any `./tui.*` import so
 * the server can resolve it in an environment where those packages are absent.
 *
 * Besides activating the sidebar (a TUI-only feature), the server side
 * registers the `abort_subagent` tool: it interrupts the active execution of
 * descendant subagent sessions the calling session spawned. The abort logic
 * lives in `subagent-abort.ts` (which only imports the pure `subagent-view.ts`).
 *
 * `setup()` stays synchronous and returns nothing. It is intentionally
 * defensive: called with no context (as `test/subagent-server-safe.test.mjs`
 * does) or with a context that lacks `tool.transform`, it is a harmless no-op.
 */
import { installAbortTool } from "./subagent-abort.ts"

export default {
  id: "subagent-sidebar-tree",
  setup(ctx?: unknown) {
    try {
      installAbortTool(ctx)
    } catch {
      /* never break host startup */
    }
  },
}
