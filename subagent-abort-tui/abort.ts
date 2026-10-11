/**
 * subagent-abort-tui — pure, dependency-free core logic.
 *
 * This module is intentionally free of `solid-js`, `@opentui/*` and any TUI
 * import so it can be unit-tested with plain Node (`--experimental-strip-types`)
 * and reasoned about in isolation. `tui.tsx` is the only consumer.
 */

/** The slash command name (`/abort`). */
export const SLASH_NAME = "abort"

/** Stable command/config keybind identifier (configurable via `keybinds`). */
export const COMMAND_ID = "subagent.abort"

/** The subset of `Context.ui.router.current()` that aborting cares about. */
export interface AbortRoute {
  readonly type?: string
  readonly sessionID?: string
}

/** The subset of `context.data.session.get()` aborting cares about. */
export interface AbortSession {
  readonly parentID?: string | null
}

/**
 * Resolve which session an abort should target.
 *
 * An abort is only possible while VIEWING a child/subagent session (one with a
 * `parentID`). Viewing a root/main session, or any non-session route, has no
 * abort target — the main session is not a subagent and must never be aborted
 * from this plugin.
 *
 * @returns the viewed child `sessionID` to abort, or `null` when there is none.
 */
export function resolveViewedChild(
  route: AbortRoute | null | undefined,
  getSession: (sessionID: string) => AbortSession | undefined,
): string | null {
  if (!route || route.type !== "session" || !route.sessionID) return null
  const session = getSession(route.sessionID)
  return session?.parentID ? route.sessionID : null
}
