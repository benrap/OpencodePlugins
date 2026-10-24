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

/**
 * Hard cap on how many parent→child levels the subtree walk will expand.
 *
 * A malformed lineage (a `parentID` cycle, or an absurdly deep chain) must not
 * let the walk run away, so the walk stops after this many levels. Sixteen is
 * far deeper than any real subagent tree.
 */
export const MAX_SUBTREE_DEPTH = 16

/** The subset of `Context.ui.router.current()` that aborting cares about. */
export interface AbortRoute {
  readonly type?: string
  readonly sessionID?: string
}

/** The subset of `context.data.session.get()` aborting cares about. */
export interface AbortSession {
  readonly parentID?: string | null
}

/** One element of a `session.list` response; only `id` is used. */
export interface ListedChild {
  readonly id?: unknown
}

/** The subset of the `context.client.session.list()` response that is used. */
export interface SessionListResponse {
  readonly data?: readonly ListedChild[]
}

/**
 * `context.client.session.list` reduced to what the subtree walk needs: given
 * a parent id, resolve that session's direct children. The real client call is
 * `session.list({ parentID, order: "desc" })`, matching
 * `subagent-sidebar-tree/tui.tsx`'s `syncChildren`.
 */
export type SubtreeLister = (
  input: { readonly parentID: string },
) => Promise<SessionListResponse | undefined>

/** The argument shape sent to `context.client.session.interrupt` when aborting. */
export interface InterruptInput {
  readonly sessionID: string
  readonly resume: false
  readonly cancelBackground: true
}

/** The plugin client surface the abort orchestrator depends on. */
export interface AbortClient {
  readonly session: {
    readonly list: SubtreeLister
    readonly interrupt: (input: InterruptInput) => Promise<unknown>
  }
}

/** Outcome of aborting a viewed session and its whole descendant subtree. */
export interface AbortSubtreeResult {
  /** Ids interrupted successfully (subset of `targets`). */
  readonly aborted: string[]
  /** Ids whose interrupt threw. */
  readonly failed: string[]
  /** Ids the walk selected, in the order they were interrupted. */
  readonly targets: string[]
}

/** A single toast to show after an abort attempt. */
export interface AbortToast {
  readonly message: string
  readonly variant: "success" | "error"
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

/** Normalize a possibly-missing session id to a trimmed string (or `""`). */
function normalizeID(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Flat-map a `session.list` response to its (trimmed, non-empty) session ids.
 * Total: malformed responses and malformed entries yield `[]`/are skipped.
 */
export function childIDs(response: SessionListResponse | null | undefined): string[] {
  const data = response && Array.isArray(response.data) ? response.data : []
  const ids: string[] = []
  for (const child of data) {
    const id = normalizeID(child?.id)
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Enumerate `rootID` plus every descendant reachable through `listChildren`,
 * breadth-first, returning the ids with the ROOT FIRST.
 *
 * Cycle/duplicate-safe: each id is emitted at most once, so a malformed
 * `parentID` chain (self-parent, cycle, diamond) terminates. Expansion is
 * capped at `options.maxDepth` levels (`MAX_SUBTREE_DEPTH` by default), so an
 * unbounded/deep chain also terminates. A throwing `listChildren` call is
 * treated as "no children" for that parent, so a single bad response cannot
 * abort the whole walk.
 *
 * @returns the de-duplicated ids, root first, in breadth-first order.
 */
export async function collectSubtreeIDs(
  rootID: string,
  listChildren: SubtreeLister,
  options?: { readonly maxDepth?: number },
): Promise<string[]> {
  const root = normalizeID(rootID)
  if (!root) return []

  const maxDepth =
    typeof options?.maxDepth === "number" && Number.isFinite(options.maxDepth)
      ? Math.max(0, Math.floor(options.maxDepth))
      : MAX_SUBTREE_DEPTH

  const ids: string[] = [root]
  const seen = new Set<string>([root])
  let frontier: string[] = [root]

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = []
    for (const parentID of frontier) {
      let response: SessionListResponse | undefined
      try {
        response = await listChildren({ parentID })
      } catch {
        response = undefined
      }
      for (const id of childIDs(response)) {
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
        next.push(id)
      }
    }
    frontier = next
  }

  return ids
}

/**
 * Build the `session.interrupt` argument for aborting `sessionID`.
 *
 * `resume: false` prevents the interrupt from immediately resuming the
 * session. `cancelBackground: true` asks the host (core patch `0004`) to also
 * cancel this session's outstanding durable background jobs; without it a
 * session parked in `waiting` would not actually stop. The flag is passed even
 * though the plugin's bundled type definitions may not list it yet.
 */
export function interruptInput(sessionID: string): InterruptInput {
  return { sessionID, resume: false, cancelBackground: true }
}

/**
 * Order a root-first subtree for interruption: DEEPEST FIRST.
 *
 * `collectSubtreeIDs` is breadth-first, so a parent always precedes its
 * children; reversing it therefore puts every descendant before its ancestor
 * (a valid topological "children before parents" order). Aborting descendants
 * first means the viewed session — which may itself be `waiting` on an
 * outstanding child — is interrupted last, so the subtree unwinds cleanly.
 */
export function interruptOrder(rootFirstIDs: readonly string[]): string[] {
  return [...rootFirstIDs].reverse()
}

/**
 * Abort the viewed session and its entire descendant subtree.
 *
 * Enumerates the subtree through `client.session.list`, orders it descendants
 * first, and interrupts each id independently with
 * `interruptInput(id)` (`{ sessionID, resume: false, cancelBackground: true }`).
 * A failing interrupt is recorded rather than thrown, so one bad session never
 * stops the rest. Total: this function does not throw.
 */
export async function abortSubtree(
  client: AbortClient,
  rootID: string,
  options?: { readonly maxDepth?: number },
): Promise<AbortSubtreeResult> {
  const collected = await collectSubtreeIDs(
    rootID,
    (input) => client.session.list(input),
    options,
  )
  const targets = interruptOrder(collected)
  const aborted: string[] = []
  const failed: string[] = []

  for (const sessionID of targets) {
    try {
      await client.session.interrupt(interruptInput(sessionID))
      aborted.push(sessionID)
    } catch {
      failed.push(sessionID)
    }
  }

  return { aborted, failed, targets }
}

/**
 * The single toast to show after an abort attempt.
 *
 * Success: `Aborted N subagents`. A partial failure: `Aborted N of M
 * subagents` (error). A total failure: `Failed to abort N subagents`.
 */
export function abortToast(result: AbortSubtreeResult): AbortToast {
  const ok = result.aborted.length
  const bad = result.failed.length

  if (bad > 0) {
    if (ok > 0) {
      return { message: `Aborted ${ok} of ${ok + bad} subagents`, variant: "error" }
    }
    return {
      message: `Failed to abort ${bad} subagent${bad === 1 ? "" : "s"}`,
      variant: "error",
    }
  }

  if (ok === 0) return { message: "No subagents to abort", variant: "success" }
  return { message: `Aborted ${ok} subagent${ok === 1 ? "" : "s"}`, variant: "success" }
}
