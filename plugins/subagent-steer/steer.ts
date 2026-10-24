/**
 * subagent-steer — pure, dependency-free core logic.
 *
 * This module is intentionally free of `solid-js`, `@opentui/*` and any TUI
 * import so it can be unit-tested with plain Node (`--experimental-strip-types`)
 * and reasoned about in isolation. `tui.tsx` is the only consumer.
 */

/** The subset of `Context.ui.router.current()` that steering cares about. */
export type SteerRoute =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionID: string }
  | { readonly type: "plugin"; readonly id: string; readonly name: string; readonly data?: Record<string, any> }

/** The subset of `context.data.session.get()` steering cares about. */
export type SteerSession = { readonly parentID?: string | null } | undefined

/**
 * Resolve which session a steer should target.
 *
 * A steer is only possible while VIEWING a child/subagent session (one with a
 * `parentID`). Viewing a root/main session, or any non-session route, has no
 * steer target — there is deliberately no "send to main" shortcut: the main
 * session already has its own visible host prompt.
 *
 * @returns the child `sessionID` to steer, or `null` when there is none.
 */
export function resolveSteerTarget(
  route: SteerRoute | null | undefined,
  getSession: (sessionID: string) => SteerSession,
): string | null {
  if (!route || route.type !== "session") return null
  const session = getSession(route.sessionID)
  return session?.parentID ? route.sessionID : null
}

/**
 * Minimal structural client contract. The real value is
 * `context.client.session`, but typing it structurally keeps this module
 * dependency-free and makes it trivial to fake in tests.
 *
 * The v2 runtime `session.prompt` body is `{ text, files?, agents?, skills? }`
 * — it has NO `parts` field.
 */
export interface SteerClient {
  session: {
    prompt(input: { readonly sessionID: string; readonly text: string }): Promise<unknown>
  }
}

/**
 * Steer `sessionID` with `text`.
 *
 * Returns `null` (and does NOT touch the client) when the text is empty or
 * whitespace-only. Otherwise sends `{ sessionID, text }` and returns the
 * client's promise.
 *
 * NOTE: no `delivery` field is sent. The v2 backend defaults prompt delivery to
 * `"steer"`, so omitting it keeps this version-agnostic (the field is optional
 * on the wire). No `parts` field is sent either: the v2 prompt body is
 * `{ text, files?, agents?, skills? }`.
 */
export function steerSession(
  client: SteerClient,
  sessionID: string,
  text: string,
): Promise<unknown> | null {
  const trimmed = typeof text === "string" ? text.trim() : ""
  if (!trimmed) return null
  return client.session.prompt({ sessionID, text: trimmed })
}
