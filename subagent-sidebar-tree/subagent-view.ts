export type SubagentSession = {
  id: string
  parentID?: string
  agent?: string
  title?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { updated: number }
}

export type SubagentStatus = "running" | "idle" | "done" | "failed" | "stopped"

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
  const pending = [...(children.get(rootID) ?? [])]

  while (pending.length > 0) {
    const session = pending.shift()
    if (!session) continue

    descendants.push(session)
    pending.push(...(children.get(session.id) ?? []))
  }

  return descendants.sort((left, right) => right.time.updated - left.time.updated)
}

export function subagentStatus(
  session: Pick<SubagentSession, "outcome">,
  activity: "idle" | "running",
): SubagentStatus {
  if (activity === "running") return "running"
  if (session.outcome === "succeeded") return "done"
  if (session.outcome === "failed") return "failed"
  if (session.outcome === "interrupted") return "stopped"
  return "idle"
}

export function isActiveSubagent(
  session: Pick<SubagentSession, "outcome">,
  activity: "idle" | "running",
): boolean {
  return subagentStatus(session, activity) === "running"
}

export function activeSubagents(
  sessions: readonly SubagentSession[],
  activityOf: (sessionID: string) => "idle" | "running",
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
  activity: "idle" | "running",
  now: number,
  windowMs = RECENT_WINDOW_MS,
): boolean {
  const status = subagentStatus(session, activity)
  if (status === "running") return true
  if (status === "idle") return false
  return now - session.time.updated <= windowMs
}

export function visibleSubagents(
  sessions: readonly SubagentSession[],
  activityOf: (sessionID: string) => "idle" | "running",
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
  activityOf: (sessionID: string) => "idle" | "running",
  now: number,
  windowMs = RECENT_WINDOW_MS,
): Set<string> {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const keep = new Set<string>()

  // base: running, or terminal within the recent window
  for (const session of sessions) {
    if (isVisibleSubagent(session, activityOf(session.id), now, windowMs)) keep.add(session.id)
  }

  // keep ancestors of every running session so a running descendant stays nested
  const isRunning = (session: SubagentSession) =>
    subagentStatus(session, activityOf(session.id)) === "running"
  for (const session of sessions) {
    if (!isRunning(session)) continue
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
          return shorten(input ? `${name} · ${input}` : `Using ${name}`)
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

export function subagentTask(messages: readonly unknown[], activity: "idle" | "running"): string {
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
