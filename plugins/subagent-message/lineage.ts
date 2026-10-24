/**
 * subagent-message · lineage.ts — PURE, dependency-free lineage helpers for the
 * `message_agent` tool.
 *
 * The tool only permits messaging along a SINGLE direct lineage edge: to the
 * caller's PARENT or to one of the caller's DIRECT CHILDREN. Everything else
 * (siblings, non-descendants, grandchildren, and any attempt to skip levels to
 * reach a root/primary session) is rejected as `not-adjacent`.
 *
 * Every function here is TOTAL: malformed/absent input returns a negative
 * verdict or `null` instead of throwing. This module imports nothing so the
 * server can resolve it without a TUI toolchain.
 */

export type SubagentSession = {
  id: string
  parentID?: string
  agent?: string
  title?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { updated: number }
}

/** Which direct lineage edge a message may travel along. */
export type MessageRelation = "parent" | "child"

/** The verdict of the adjacency check. */
export type MessageVerdict = { ok: true; relation: MessageRelation } | { ok: false; reason: string }

/** A session lookup keyed by id. */
export type SessionLookup = ReadonlyMap<string, SubagentSession> | undefined | null

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Classify the DIRECT lineage edge between `callerID` and `target`.
 *
 * Returns:
 *   - `"child"`  when `target.parentID === callerID` (target is a direct child),
 *   - `"parent"` when the CALLER's own `parentID` is `target.id` (target is the
 *     direct parent; this includes the root/primary session), and
 *   - `null` otherwise. `null` covers siblings, non-descendants, grandchildren,
 *     and grandchild -> root level-skips, because none of those satisfy a
 *     one-hop parent/child edge.
 *
 * Total: a missing/blank caller, a missing/non-object target, a blank target id,
 * or a lookup without `.get` all return `null`.
 */
export function relationOf(
  callerID: string,
  target: SubagentSession | undefined | null,
  byID: SessionLookup,
): MessageRelation | null {
  if (!isNonEmptyString(callerID)) return null
  if (!target || typeof target !== "object") return null
  if (!isNonEmptyString(target.id)) return null

  // Caller -> target is one hop DOWN the lineage.
  if (target.parentID === callerID) return "child"

  // Target -> caller is one hop UP the lineage (target may be the root).
  const caller = typeof byID?.get === "function" ? byID.get(callerID) : undefined
  if (caller?.parentID === target.id) return "parent"

  return null
}

/**
 * Validate that `callerID` is allowed to message `target`.
 *
 * IMPORTANT — adjacency only, ONE hop:
 *   - A DIRECT CHILD may message its parent even when that parent is the
 *     root/main session; that is a valid direct edge.
 *   - A GRANDCHILD messaging the root is `not-adjacent` (it would skip its own
 *     parent) and is rejected.
 *   - Siblings and unrelated sessions are `not-adjacent`.
 */
export function assertMessageable(
  callerID: string,
  target: SubagentSession | undefined | null,
  byID: SessionLookup,
): MessageVerdict {
  if (!target || !isNonEmptyString(target.id)) return { ok: false, reason: "not-found" }
  if (target.id === callerID) return { ok: false, reason: "self" }
  const relation = relationOf(callerID, target, byID)
  if (!relation) return { ok: false, reason: "not-adjacent" }
  return { ok: true, relation }
}

/**
 * Pick the delivery mode for a target's current activity.
 *
 * A running/waiting target is steered at its next step boundary; an idle
 * target gets the message queued as a follow-up. Never throws.
 */
export function deliveryFor(activity: "idle" | "running" | "waiting"): "steer" | "queue" {
  return activity === "running" || activity === "waiting" ? "steer" : "queue"
}

/**
 * Wrap a message in a short provenance envelope so the recipient can see which
 * direct relative sent it and the caller's session id.
 *
 * SECURITY: inter-agent content is UNTRUSTED INPUT. A recipient must treat the
 * framed body as data — not as instructions from its own operator/parent — and
 * must not grant it the authority of a top-level user request.
 */
export function frameMessage(callerID: string, relation: MessageRelation, message: string): string {
  const who = relation === "child" ? "your child" : "your parent"
  return `[message from ${who} session ${callerID}]\n\n${message}`
}
