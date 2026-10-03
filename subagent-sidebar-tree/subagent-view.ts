export type SubagentSession = {
  id: string
  parentID?: string
  agent?: string
  title?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { updated: number }
}

export type SubagentStatus = "running" | "waiting" | "idle" | "done" | "failed" | "stopped"

/**
 * Separator between the segments of a subagent row's first line. A SPACED
 * middle dot so the row reads `general · running · 131K (13%)`. A shared
 * constant so the TUI spans and the tests assert the exact same glyph.
 */
export const ROW_SEPARATOR = " · "

export type SubagentTreeNode = {
  session: SubagentSession
  depth: number
  isLast: boolean
  ancestorIsLast: boolean[]
  prefix: string
  contPrefix: string
}

export function descendantSessions(sessions: readonly SubagentSession[], rootID: string): SubagentSession[] {
  const children = new Map<string, SubagentSession[]>()

  for (const session of sessions) {
    if (!session.parentID) continue
    const siblings = children.get(session.parentID) ?? []
    siblings.push(session)
    children.set(session.parentID, siblings)
  }

  const descendants: SubagentSession[] = []
  const seen = new Set<string>()
  const pending = [...(children.get(rootID) ?? [])]

  while (pending.length > 0) {
    const session = pending.shift()
    if (!session) continue
    // Cycle/malformed-lineage guard: a self-parent or cyclic parentID chain
    // would otherwise grow `pending` without bound and throw. Each session is
    // expanded at most once.
    if (seen.has(session.id)) continue
    seen.add(session.id)

    descendants.push(session)
    pending.push(...(children.get(session.id) ?? []))
  }

  return descendants.sort((left, right) => right.time.updated - left.time.updated)
}

/** A session map keyed by id, or a plain session list. */
export type SessionsByID =
  | ReadonlyMap<string, SubagentSession>
  | readonly SubagentSession[]

function sessionsIndex(sessionsByID: SessionsByID): ReadonlyMap<string, SubagentSession> {
  if (sessionsByID instanceof Map) return sessionsByID
  const byID = new Map<string, SubagentSession>()
  for (const session of sessionsByID) byID.set(session.id, session)
  return byID
}

function idSet(value: string | readonly string[] | undefined): Set<string> {
  const set = new Set<string>()
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed) set.add(trimmed)
  } else if (Array.isArray(value)) {
    for (const id of value) {
      if (typeof id === "string" && id.trim()) set.add(id.trim())
    }
  }
  return set
}

/** True when a session has no parent, i.e. it is a root/primary session. */
export function isRootSession(
  session: Pick<SubagentSession, "parentID"> | undefined | null,
): boolean {
  return !session?.parentID
}

/**
 * True only when `ancestorID` sits STRICTLY above `targetID` in the `parentID`
 * chain. Cycle-safe and missing-parent-safe: a broken chain (a `parentID` that
 * is absent from `sessionsByID`) returns false, and a cycle terminates false
 * without ever claiming the target is its own descendant.
 */
export function isDescendantOf(
  targetID: string,
  ancestorID: string,
  sessionsByID: SessionsByID,
): boolean {
  if (!targetID || !ancestorID) return false
  // A session is never its own descendant, even inside a parentID cycle.
  if (targetID === ancestorID) return false
  const byID = sessionsIndex(sessionsByID)
  const visited = new Set<string>([targetID])
  let parentID = byID.get(targetID)?.parentID

  while (parentID) {
    if (parentID === ancestorID) return true
    if (visited.has(parentID)) return false
    visited.add(parentID)
    const parent = byID.get(parentID)
    if (!parent) return false // chain breaks before reaching the ancestor
    parentID = parent.parentID
  }

  return false
}

export type AbortTargetsOptions = {
  /** Select every running descendant of the focused session. */
  all?: boolean
  /** When set, restrict the result to these explicit descendant ids. */
  sessionID?: string | readonly string[]
  /** Activity resolver; defaults to "running" until a terminal outcome exists. */
  activityOf?: (session: SubagentSession) => "idle" | "running" | "waiting"
}

function defaultActivity(session: SubagentSession): "idle" | "running" | "waiting" {
  return session.outcome == null ? "running" : "idle"
}

/**
 * Running descendants of `focusedSessionID`, never the focused session itself
 * and never a root. With `opts.all` every running descendant is returned;
 * otherwise only the running descendants named by `opts.sessionID` are.
 */
export function abortTargets(
  focusedSessionID: string,
  sessions: readonly SubagentSession[],
  opts: AbortTargetsOptions = {},
): SubagentSession[] {
  if (!focusedSessionID) return []
  const activityOf = opts.activityOf ?? defaultActivity
  const byID = sessionsIndex(sessions)
  const running = descendantSessions(sessions, focusedSessionID).filter((session) => {
    if (isRootSession(session)) return false
    if (session.id === focusedSessionID) return false
    if (!isDescendantOf(session.id, focusedSessionID, byID)) return false
    return activityOf(session) === "running"
  })

  if (opts.all) return running

  const wanted = idSet(opts.sessionID)
  if (wanted.size === 0) return []
  return running.filter((session) => wanted.has(session.id))
}

export type AbortVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Validate a single abort target. Rejects roots, self-aborts, sessions that
 * are not descendants of the caller, and sessions with a terminal outcome.
 */
export function assertAbortable(
  callerSessionID: string,
  target: SubagentSession | undefined | null,
  sessionsByID: SessionsByID,
): AbortVerdict {
  if (!target || typeof target.id !== "string" || !target.id) {
    return { ok: false, reason: "not-found" }
  }
  if (isRootSession(target)) return { ok: false, reason: "root" }
  if (target.id === callerSessionID) return { ok: false, reason: "self" }
  if (!isDescendantOf(target.id, callerSessionID, sessionsByID)) {
    return { ok: false, reason: "not-descendant" }
  }
  if (target.outcome != null) return { ok: false, reason: "terminal" }
  return { ok: true }
}

export function subagentStatus(
  session: Pick<SubagentSession, "outcome">,
  activity: "idle" | "running" | "waiting",
): SubagentStatus {
  // `waiting` means the child's turn settled but background work (e.g. a
  // backgrounded shell) is still outstanding, so it is NOT done yet.
  if (activity === "waiting") return "waiting"
  if (activity === "running") return "running"
  if (session.outcome === "succeeded") return "done"
  if (session.outcome === "failed") return "failed"
  if (session.outcome === "interrupted") return "stopped"
  return "idle"
}

export function isActiveSubagent(
  session: Pick<SubagentSession, "outcome">,
  activity: "idle" | "running" | "waiting",
): boolean {
  const status = subagentStatus(session, activity)
  return status === "running" || status === "waiting"
}

export function activeSubagents(
  sessions: readonly SubagentSession[],
  activityOf: (sessionID: string) => "idle" | "running" | "waiting",
): SubagentSession[] {
  return sessions.filter((session) => isActiveSubagent(session, activityOf(session.id)))
}

/**
 * How long a finished (done/failed/stopped) subagent stays visible after its
 * last update. Running subagents are always visible; idle ones never are.
 */
export const RECENT_WINDOW_MS = 60_000

/**
 * A subagent is visible while running, or for `windowMs` after a terminal
 * outcome (done/failed/stopped). Idle subagents are never visible.
 */
export function isVisibleSubagent(
  session: Pick<SubagentSession, "outcome" | "time">,
  activity: "idle" | "running" | "waiting",
  now: number,
  windowMs = RECENT_WINDOW_MS,
): boolean {
  const status = subagentStatus(session, activity)
  if (status === "running" || status === "waiting") return true
  if (status === "idle") return false
  return now - session.time.updated <= windowMs
}

export function visibleSubagents(
  sessions: readonly SubagentSession[],
  activityOf: (sessionID: string) => "idle" | "running" | "waiting",
  now: number,
  windowMs = RECENT_WINDOW_MS,
): SubagentSession[] {
  return sessions.filter((session) => isVisibleSubagent(session, activityOf(session.id), now, windowMs))
}

/**
 * IDs that should be shown below `rootID`.
 *
 * Base visibility is per-session (`isVisibleSubagent`): running, or terminal
 * within the recent window. On top of that, every ancestor of a still-running
 * session is kept even when that ancestor finished long ago, so a running
 * descendant stays nested under its (possibly `done`) parent instead of being
 * promoted or dropped. `rootID` itself is never included.
 */
export function visibleSubagentIDs(
  sessions: readonly SubagentSession[],
  rootID: string,
  activityOf: (sessionID: string) => "idle" | "running" | "waiting",
  now: number,
  windowMs = RECENT_WINDOW_MS,
): Set<string> {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const keep = new Set<string>()

  // base: running, waiting, or terminal within the recent window
  for (const session of sessions) {
    if (isVisibleSubagent(session, activityOf(session.id), now, windowMs)) keep.add(session.id)
  }

  // keep ancestors of every active (running or waiting) session so an active
  // descendant stays nested
  const isActive = (session: SubagentSession) => isActiveSubagent(session, activityOf(session.id))
  for (const session of sessions) {
    if (!isActive(session)) continue
    let parentID = session.parentID
    while (parentID && parentID !== rootID) {
      keep.add(parentID)
      parentID = byId.get(parentID)?.parentID
    }
  }

  keep.delete(rootID)
  return keep
}

/**
 * Build the Unicode box-drawing connector prefix for a node.
 *
 * For every ancestor level emit `"│  "` when that ancestor is not its parent's
 * last child, otherwise `"   "` (3 columns so continuations align with the node
 * connector). Then append `"└─ "` when the node is its parent's last child, or
 * `"├─ "` otherwise.
 *
 * Example:
 *   ├─ parent A
 *   │  ├─ child A1
 *   │  └─ child A2
 *   └─ parent B
 */
export function treePrefix(ancestorIsLast: readonly boolean[], isLast = false): string {
  let prefix = ""
  for (const flag of ancestorIsLast) {
    prefix += flag ? "   " : "│  "
  }
  return `${prefix}${isLast ? "└─ " : "├─ "}`
}

/**
 * Build the continuation prefix for a node's second (title/preview) line.
 *
 * Uses the same 3-column segments as `treePrefix`, but the final segment is a
 * plain `"│  "` when the node is NOT its parent's last child, so the vertical
 * line carries through the title line to the next sibling, and `"   "` when
 * the node is last (nothing follows, so the line stops).
 */
export function treeContinuation(ancestorIsLast: readonly boolean[], isLast = false): string {
  let prefix = ""
  for (const flag of ancestorIsLast) prefix += flag ? "   " : "│  "
  return `${prefix}${isLast ? "   " : "│  "}`
}

/** A node in the flattened, visibility-aware tree. */
type TreeNode = { session: SubagentSession; children: TreeNode[] }

/**
 * Flatten the descendant sessions below `rootID` into a depth-first tree.
 *
 * Sibling buckets are sorted by `time.updated` DESC. Connectors are computed
 * over the VISIBLE structure only: a node's `├─`/`└─` and the ancestor `│`
 * columns reflect its visible siblings, never invisible ones. An invisible
 * intermediate is removed and its visible descendants are promoted to the
 * nearest visible level, keeping the visible set connected.
 *
 * A visited set guards against malformed `parentID` chains (e.g. cycles) and
 * prevents emitting the same session twice when it is reachable by more than
 * one path.
 */
export function subagentTree(
  sessions: readonly SubagentSession[],
  rootID: string,
  isVisible: (session: SubagentSession) => boolean,
): SubagentTreeNode[] {
  const children = new Map<string, SubagentSession[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const siblings = children.get(session.parentID) ?? []
    siblings.push(session)
    children.set(session.parentID, siblings)
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => right.time.updated - left.time.updated)
  }

  const visited = new Set<string>()

  const buildLevel = (parentId: string): TreeNode[] => {
    const nodes: TreeNode[] = []
    for (const child of children.get(parentId) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      if (isVisible(child)) {
        nodes.push({ session: child, children: buildLevel(child.id) })
      } else {
        // Invisible intermediate: promote its visible descendants to this level.
        nodes.push(...buildLevel(child.id))
      }
    }
    return nodes
  }

  const flatten = (nodes: TreeNode[], ancestorIsLast: boolean[], out: SubagentTreeNode[]): void => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      const isLast = index === nodes.length - 1
      out.push({
        session: node.session,
        depth: ancestorIsLast.length,
        isLast,
        ancestorIsLast: [...ancestorIsLast],
        prefix: treePrefix(ancestorIsLast, isLast),
        contPrefix: treeContinuation(ancestorIsLast, isLast),
      })
      flatten(node.children, [...ancestorIsLast, isLast], out)
    }
  }

  const out: SubagentTreeNode[] = []
  flatten(buildLevel(rootID), [], out)
  return out
}

export function shorten(value: unknown, maxLength = 52): string {
  const text = (value == null ? "" : String(value)).replace(/\s+/g, " ").trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function toolInputSummary(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined

  const keys = ["path", "filePath", "command", "cmd", "query", "pattern", "url", "description", "prompt"]
  for (const key of keys) {
    const value = stringValue(input[key])
    if (value) return shorten(value, 32)
  }

  return undefined
}

function latestUserText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.type !== "user") continue
    const text = stringValue(message.text)
    if (text) return shorten(text)
  }

  return undefined
}

function latestAssistantActivity(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue

    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex]
      if (!isRecord(part)) continue

      if (part.type === "tool" && isRecord(part.state)) {
        const state = part.state.status
        if (state === "running" || state === "streaming") {
          const name = stringValue(part.name) ?? "tool"
          const input = toolInputSummary(part.state.input)
          return shorten(input ? `${name}${ROW_SEPARATOR}${input}` : `Using ${name}`)
        }
      }

      if (part.type === "text" || part.type === "reasoning") {
        const text = stringValue(part.text)
        if (text) return shorten(text)
      }
    }
  }

  return undefined
}

/**
 * Description of the NEWEST `task` tool call in a PARENT session's messages
 * that targets `childSessionID`.
 *
 * OpenCode does not update a child session's `title` when that child is
 * continued/resumed, so a sidebar that renders `session.title` goes stale while
 * the actual chat shows the new text. The authoritative newest text is the
 * `description` passed to the most recent Task tool call in the parent's
 * messages (`ctx.metadata({ title: params.description, metadata: { sessionId } })`).
 *
 * Scans messages newest -> oldest and, within each, parts newest -> oldest.
 * Fully defensive (accepts `tool`, `tool-invocation`/`tool_call`, `name`/`tool`,
 * nested or direct `metadata`/`input`, `sessionId`/`sessionID`/`task_id`/
 * `taskId`), tolerates malformed input, and never throws.
 */
export function latestTaskDescription(
  messages: readonly unknown[],
  childSessionID: string,
): string | undefined {
  if (!stringValue(childSessionID)) return undefined

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || !Array.isArray(message.content)) continue

    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex]
      if (!isRecord(part)) continue

      const type = part.type
      const isToolPart = type === "tool" || type === "tool-invocation" || type === "tool_call"
      const name = stringValue(part.name) ?? stringValue(part.tool)
      if (name !== "task") continue
      if (!isToolPart && stringValue(part.tool) !== "task") continue

      const state = isRecord(part.state) ? part.state : undefined
      const stateMetadata = state && isRecord(state.metadata) ? state.metadata : undefined
      const stateInput = state && isRecord(state.input) ? state.input : undefined
      const metadata = isRecord(part.metadata) ? part.metadata : undefined
      const input = isRecord(part.input) ? part.input : undefined

      const referenced =
        stringValue(stateMetadata?.sessionId) ??
        stringValue(metadata?.sessionId) ??
        stringValue(stateInput?.sessionID) ??
        stringValue(stateInput?.sessionId) ??
        stringValue(stateInput?.task_id) ??
        stringValue(stateInput?.taskId) ??
        stringValue(input?.sessionID) ??
        stringValue(input?.sessionId) ??
        stringValue(input?.task_id) ??
        stringValue(input?.taskId)

      if (referenced !== childSessionID) continue

      const description =
        stringValue(stateInput?.description) ??
        stringValue(input?.description) ??
        stringValue(state?.title) ??
        stringValue(part.title)
      if (description) return description
    }
  }

  return undefined
}

export function subagentTask(messages: readonly unknown[], activity: "idle" | "running" | "waiting"): string {
  if (activity === "running") {
    const current = latestAssistantActivity(messages)
    if (current) return current
  }

  return latestUserText(messages) ?? latestAssistantActivity(messages) ?? "Waiting for work"
}

export type SubagentAgentRef = {
  id?: string
  name?: string
  hidden?: boolean
  color?: string
}

/**
 * Deterministic 32-bit string hash (Horner's method, `hash * 31 + char`).
 * Used to pick a stable palette slot for an agent id when the host's agent
 * list is unavailable, so the same agent type always keeps the same color.
 */
export function stableHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash
}

/**
 * Resolve the palette index for an agent id.
 *
 * Mirrors the host's coloring: hidden agents are skipped, a known visible agent
 * uses its position in the visible list, and an unknown/empty id falls back to a
 * stable hash of the id. Returns -1 when there is no palette to index.
 */
export function agentColorIndex(
  agents: readonly SubagentAgentRef[],
  agentId: string | undefined,
  paletteLength: number,
): number {
  if (paletteLength <= 0) return -1

  const visible = agents.filter((agent): agent is SubagentAgentRef => Boolean(agent) && !agent.hidden)
  const wanted = agentId?.toLowerCase()
  const found = wanted
    ? visible.findIndex(
        (agent) => agent?.id?.toLowerCase() === wanted || agent?.name?.toLowerCase() === wanted,
      )
    : -1
  if (found >= 0) return found % paletteLength

  if (!agentId) return 0
  const hash = stableHash(agentId)
  return ((hash % paletteLength) + paletteLength) % paletteLength
}

/**
 * Resolve the primary (base/default) text color from a theme `text` record.
 *
 * Newer theme shapes expose `text.default`; older ones expose `text.base`.
 * PURE and host-independent so it can be unit tested without the TUI.
 */
export function resolveBaseColor(text: unknown): unknown {
  const t = (text ?? {}) as { base?: unknown; default?: unknown }
  return t.base ?? t.default
}

/**
 * Resolve a genuinely MUTED (grey) text color from a theme `text` record.
 *
 * Prefers `text.muted` (newer themes) or `text.subdued` (v2.0.6). Crucially it
 * NEVER falls back to `text.base`/`text.default` — those are the primary/white
 * color and were the cause of the `done` label rendering plain white. When the
 * theme has no muted alias it falls back to the `hue.neutral` scale (400, then
 * 300) and finally to a hardcoded grey, so the result is always grey.
 */
export function resolveMutedColor(text: unknown, hue: unknown): unknown {
  const t = (text ?? {}) as { muted?: unknown; subdued?: unknown; base?: unknown; default?: unknown }
  const muted = t.muted ?? t.subdued
  if (muted) return muted
  const neutral = (hue ?? {}) as { neutral?: Record<number, unknown> }
  return neutral.neutral?.[400] ?? neutral.neutral?.[300] ?? "#808080"
}


// ---------------------------------------------------------------- context usage
// Ported from OpenCode v2.0.6 TUI `util/locale.ts` (Locale.number) and
// `util/session.ts` (formatContextUsage/contextUsage), which are not exported to
// plugins. Pure and defensive so they can be unit-tested without the TUI.

/**
 * Format a token count as a WHOLE number with a `K`/`M` suffix and no decimal
 * point: `999`, `1K`, `1500 -> 2K`, `131K`, `1M`.
 *
 * The host's `Locale.number` emits one decimal for thousands (`131.0K`), which
 * the sidebar found too wide, so this intentionally diverges from it. Values
 * below 1000 stay exact and unsuffixed. From 1000 up we divide by 1000 (or
 * 1e6 for M) and `Math.round` to the nearest whole number (half rounds up,
 * e.g. `1500 -> 2K`). If rounding a K value carries it to `1000K`, it is
 * normalized to `1M` (`999500 -> 1M`) so the suffix never reaches four digits.
 */
export function formatTokenCount(value: number): string {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0
  if (num < 1_000) return num.toString()
  if (num < 1_000_000) {
    const thousands = Math.round(num / 1_000)
    if (thousands < 1_000) return `${thousands}K`
    // Rounding pushed 999500..999999 up to 1000K: carry into millions.
    return `${Math.round(num / 1_000_000)}M`
  }
  return `${Math.round(num / 1_000_000)}M`
}

/**
 * `131K (13%)`, or `131K` when the percent is unknown. Returns undefined when
 * there are no tokens to show.
 */
export function formatContextUsage(tokens: number | undefined, percent?: number): string | undefined {
  if (tokens === undefined || tokens === null) return undefined
  const value = formatTokenCount(tokens)
  return percent === undefined ? value : `${value} (${percent}%)`
}

export type ContextUsage = { tokens: number; percent: number | undefined }

function tokenNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Last assistant message carrying token usage, ignoring everything at or before
 * the most recent COMPLETED compaction, and never reading past
 * `boundaryMessageID`. Mirrors the host's `lastAssistantWithUsage`.
 */
export function lastAssistantWithUsage(
  messages: readonly unknown[],
  boundaryMessageID?: string,
): unknown | undefined {
  if (!Array.isArray(messages)) return undefined
  let boundaryIndex = -1
  if (boundaryMessageID) {
    boundaryIndex = messages.findIndex((message) => isRecord(message) && message.id === boundaryMessageID)
    if (boundaryIndex === -1) return undefined
  }
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  let compactionIndex = -1
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isRecord(message) && message.type === "compaction" && message.status === "completed") {
      compactionIndex = index
      break
    }
  }
  for (let index = end - 1; index > compactionIndex; index -= 1) {
    const message = messages[index]
    if (isRecord(message) && message.type === "assistant" && isRecord(message.tokens)) return message
  }
  return undefined
}

/**
 * Sum the tokens of the last usable assistant message and compute its share of
 * the model's context window. Returns undefined when there is no usage.
 * Defensive: malformed messages/models never throw; missing token fields count
 * as zero and a missing `limit.context` yields an undefined percent.
 */
export function contextUsage(
  messages: readonly unknown[],
  models: readonly unknown[] | undefined,
  boundaryMessageID?: string,
): ContextUsage | undefined {
  const last = lastAssistantWithUsage(messages, boundaryMessageID)
  if (!isRecord(last) || !isRecord(last.tokens)) return undefined
  const tokens = last.tokens
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  const total =
    tokenNumber(tokens.input) +
    tokenNumber(tokens.output) +
    tokenNumber(tokens.reasoning) +
    tokenNumber(cache.read) +
    tokenNumber(cache.write)
  if (total <= 0) return undefined
  const messageModel = isRecord(last.model) ? last.model : undefined
  const model =
    messageModel && Array.isArray(models)
      ? (models.find(
          (candidate) =>
            isRecord(candidate) &&
            candidate.providerID === messageModel.providerID &&
            candidate.id === messageModel.id,
        ) as Record<string, unknown> | undefined)
      : undefined
  const limit = model && isRecord(model.limit) ? model.limit : undefined
  const contextLimit = limit ? tokenNumber(limit.context) : 0
  const percent = contextLimit > 0 ? Math.round((total / contextLimit) * 100) : undefined
  return { tokens: total, percent }
}
