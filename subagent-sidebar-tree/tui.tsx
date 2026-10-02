/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  agentColorIndex,
  contextUsage,
  descendantSessions,
  formatContextUsage,
  latestTaskDescription,
  resolveBaseColor,
  resolveMutedColor,
  ROW_SEPARATOR,
  shorten,
  subagentStatus,
  subagentTask,
  subagentTree,
  visibleSubagentIDs,
  type SubagentSession,
  type SubagentStatus,
  type SubagentTreeNode,
} from "./subagent-view"

const MAX_VISIBLE_SUBAGENTS = 8
const MAX_EXPANDED_HEIGHT = 16
const CATEGORICAL_STEP = 200

const FALLBACK_PALETTE: readonly string[] = [
  "#5c9cf5", // blue
  "#9d7cd8", // purple
  "#7fd88f", // green
  "#fab283", // orange
  "#e06c75", // red
  "#56b6c2", // cyan
]

function colorFromCategoricalEntry(entry: unknown): unknown {
  if (!entry) return undefined
  if (typeof entry === "object") {
    const record = entry as Record<string | number, unknown>
    const stepped = record[CATEGORICAL_STEP] ?? record[String(CATEGORICAL_STEP)] ?? record[500] ?? record["500"]
    if (stepped) return stepped
    const maybe = entry as { toInt?: unknown; toHex?: unknown }
    if (typeof maybe.toInt === "function" || typeof maybe.toHex === "function") return entry
    return undefined
  }
  return entry
}

const STATUS_LABELS: Record<SubagentStatus, string> = {
  running: "running",
  idle: "idle",
  done: "done",
  failed: "failed",
  stopped: "interrupted",
}

type SyncState = {
  children: Set<string>
  messages: Set<string>
}

function sessionLabel(session: SubagentSession): string {
  return shorten(session.agent ?? session.title ?? "subagent", 24)
}

function isPrimaryMouseButton(event: { button: number }): boolean {
  return event.button === 0
}

function openSubagent(context: Context, sessionID: string, event: { button: number }): void {
  if (!isPrimaryMouseButton(event)) return
  context.ui.router.navigate({ type: "session", sessionID })
}

/**
 * Stable equality key for an RGBA-like color. OpenTUI's `RGBA` may expose
 * `toInt()`/`toString()`; fall back to JSON or `String(value)` when it does not.
 */
function colorKey(value: unknown): string {
  if (!value) return ""
  const candidate = value as { toInt?: () => number; toString?: () => string }
  if (typeof candidate.toInt === "function") {
    try {
      return `int:${candidate.toInt()}`
    } catch {
      /* fall through */
    }
  }
  if (typeof candidate.toString === "function") {
    try {
      const text = candidate.toString()
      if (text && text !== "[object Object]") return `str:${text}`
    } catch {
      /* fall through */
    }
  }
  try {
    return `json:${JSON.stringify(value)}`
  } catch {
    return `raw:${String(value)}`
  }
}

function SubagentRow(props: { context: Context; session: SubagentSession; node: SubagentTreeNode }) {
  const [hovered, setHovered] = createSignal(false)
  const session = () => props.context.data.session.get(props.session.id) ?? props.session
  const activity = () => props.context.data.session.status(props.session.id)
  const status = () => subagentStatus(session(), activity())
  const messages = () => props.context.data.session.message.list(props.session.id)
  const sessionLocation = () => (session() as unknown as { location?: unknown }).location
  const models = () => {
    try {
      const data = props.context.data as unknown as {
        location?: { model?: { list?: (location: unknown) => unknown } }
      }
      const list = data?.location?.model?.list?.(sessionLocation())
      return Array.isArray(list) ? list : undefined
    } catch {
      return undefined
    }
  }
  const contextText = () => {
    try {
      const usage = contextUsage(
        messages(),
        models(),
        (session() as unknown as { revert?: { messageID?: string } }).revert?.messageID,
      )
      return usage ? formatContextUsage(usage.tokens, usage.percent) : undefined
    } catch {
      return undefined
    }
  }
  const width = () => props.node.prefix.length

  const parentMessages = () => {
    const parentID = props.session.parentID
    if (!parentID) return []
    try {
      const list = props.context.data.session.message.list(parentID)
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  createEffect(() => {
    const parentID = props.session.parentID
    // Track the child's last update so a continued/resumed child re-pulls the
    // parent's messages, where the newest Task description lives.
    session().time.updated
    if (!parentID) return
    try {
      const sync = props.context.data.session.message.sync
      if (typeof sync === "function") void sync(parentID).catch(() => {})
    } catch {
      /* optional API: the preview falls back to the child's stored title */
    }
  })

  const baseColor = () => resolveBaseColor(props.context.theme.text)
  const mutedColor = () => resolveMutedColor(props.context.theme.text, props.context.theme.hue)

  const agentList = () => {
    try {
      const data = props.context.data as unknown as {
        location?: { agent?: { list?: (location: unknown) => unknown } }
      }
      const location = (props.context as unknown as { location?: unknown }).location
      const list = data?.location?.agent?.list?.(location)
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  const palette = (): unknown[] => {
    try {
      const scales = (props.context.theme as unknown as { categorical?: unknown }).categorical
      const entries = Array.isArray(scales)
        ? scales
        : scales && typeof scales === "object"
          ? Object.values(scales as Record<string, unknown>)
          : []
      const seen = new Set<string>()
      const unique: unknown[] = []
      for (const entry of entries) {
        const value = colorFromCategoricalEntry(entry)
        if (!value) continue
        const key = colorKey(value)
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(value)
      }
      return unique.length > 0 ? unique : [...FALLBACK_PALETTE]
    } catch {
      return [...FALLBACK_PALETTE]
    }
  }

  const agentColor = () => {
    try {
      const agents = agentList() as { id?: string; name?: string; hidden?: boolean; color?: string }[]
      const id = session().agent
      const wanted = id?.toLowerCase()
      const explicit = wanted
        ? agents.find(
            (agent) =>
              agent?.id?.toLowerCase() === wanted || agent?.name?.toLowerCase() === wanted,
          )
        : undefined
      if (explicit && typeof explicit.color === "string" && explicit.color) return explicit.color
      const colors = palette()
      const index = agentColorIndex(agents, id, colors.length)
      if (index >= 0 && index < colors.length) return colors[index]
    } catch {
      /* fall back to the base text color */
    }
    return baseColor()
  }

  const activityColor = () => {
    const muted = mutedColor()
    try {
      const theme = props.context.theme as unknown as {
        source?: (value: unknown) => unknown
        increase?: (value: unknown, amount: number) => unknown
        hue?: { neutral?: Record<number, unknown> }
      }
      if (
        typeof theme?.source === "function" &&
        typeof theme?.increase === "function" &&
        theme.source(muted)
      ) {
        return theme.increase(muted, 1)
      }
      if (theme?.hue?.neutral?.[500]) return theme.hue.neutral[500]
    } catch {
      /* fall back to muted grey */
    }
    return mutedColor()
  }

  const statusColor = (value: SubagentStatus): unknown => {
    // running -> green, failed -> red, stopped -> orange, done/idle -> mute grey
    if (value === "running") {
      try {
        const theme = props.context.theme as unknown as {
          text?: { feedback?: { success?: { base?: unknown } } }
          hue?: { green?: Record<number, unknown> }
        }
        const green = theme.text?.feedback?.success?.base ?? theme.hue?.green?.[400]
        if (green) return green
      } catch {
        /* fall through to the default green */
      }
      return "#7fd88f"
    }
    if (value === "failed") {
      try {
        const theme = props.context.theme as unknown as {
          text?: { feedback?: { error?: { base?: unknown } } }
          hue?: { red?: Record<number, unknown> }
        }
        const red = theme.text?.feedback?.error?.base ?? theme.hue?.red?.[400]
        if (red) return red
      } catch {
        /* fall through to the default red */
      }
      return "#e06c75"
    }
    if (value === "stopped") {
      try {
        const theme = props.context.theme as unknown as {
          text?: { feedback?: { warning?: { base?: unknown } } }
          hue?: { orange?: Record<number, unknown> }
        }
        const orange = theme.text?.feedback?.warning?.base ?? theme.hue?.orange?.[400]
        if (orange) return orange
      } catch {
        /* fall through to the default orange */
      }
      return "#f5a742"
    }
    return mutedColor()
  }

  const rowTone = (): { name: unknown; preview: unknown } => {
    // Every status keeps the per-agent color for the NAME and the dim activity
    // color for the preview; only the status label is tinted (green/red/orange/
    // grey) via statusColor.
    return { name: agentColor(), preview: hovered() ? baseColor() : activityColor() }
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => openSubagent(props.context, props.session.id, event)}
    >
      <text fg={baseColor()} wrapMode="none">
        <span style={{ get fg() { return mutedColor() } }}>{props.node.prefix}</span>
        <span style={{ get fg() { return rowTone().name } }}>{shorten(sessionLabel(session()), Math.max(8, 24 - width()))}</span>
        {ROW_SEPARATOR}
        <span style={{ get fg() { return statusColor(status()) } }}>{STATUS_LABELS[status()]}</span>
        <Show when={contextText()}>
          {ROW_SEPARATOR}
          <span style={{ get fg() { return mutedColor() } }}>{contextText()}</span>
        </Show>
      </text>
      <text fg={rowTone().preview} wrapMode="none">
        <span style={{ get fg() { return mutedColor() } }}>{props.node.contPrefix}</span>
        {shorten(
          latestTaskDescription(parentMessages(), props.session.id) ||
            session().title ||
            subagentTask(messages(), activity()),
          Math.max(8, 48 - width()),
        )}
      </text>
    </box>
  )
}

function SidebarSubagents(props: { context: Context; sessionID: string; syncState: SyncState }) {
  const { context } = props
  const themedBg = props.context.theme.background as {
    base?: unknown
    raised?: { base?: unknown }
    default?: unknown
    surface?: { offset?: unknown }
  }
  const raisedBg = () =>
    themedBg.raised?.base ?? themedBg.base ?? themedBg.surface?.offset ?? themedBg.default
  const [now, setNow] = createSignal(Date.now())
  const [expanded, setExpanded] = createSignal(false)
  const [moreHovered, setMoreHovered] = createSignal(false)
  const [collapseHovered, setCollapseHovered] = createSignal(false)
  const sessions = createMemo(() =>
    descendantSessions(context.data.session.list(), props.sessionID),
  )
  const visible = createMemo(() =>
    visibleSubagentIDs(
      sessions(),
      props.sessionID,
      (sessionID) => context.data.session.status(sessionID),
      now(),
    ),
  )
  const nodes = createMemo(() =>
    subagentTree(sessions(), props.sessionID, (session) => visible().has(session.id)),
  )
  const displayedNodes = createMemo(() =>
    expanded() ? nodes() : nodes().slice(0, MAX_VISIBLE_SUBAGENTS),
  )

  createEffect(() => {
    try {
      const timer = setInterval(() => setNow(Date.now()), 1000)
      onCleanup(() => clearInterval(timer))
    } catch {
      /* setInterval unavailable: keep the initial timestamp */
    }
  })

  createEffect(() => {
    sessions()
    syncChildren(context, props.sessionID, props.syncState)
  })

  createEffect(() => {
    for (const node of displayedNodes()) {
      syncMessages(context, node.session.id, props.syncState)
    }
  })

  const expand = (event: { button: number }) => {
    if (isPrimaryMouseButton(event)) setExpanded(true)
  }

  const collapse = (event: { button: number }) => {
    if (isPrimaryMouseButton(event)) setExpanded(false)
  }

  return (
    <Show when={nodes().length > 0}>
      <box flexDirection="column" paddingBottom={1}>
        <text fg={context.theme.text.base} wrapMode="none">
          SUBAGENTS ({nodes().length})
        </text>
        <Show
          when={expanded()}
          fallback={
            <box flexDirection="column">
              <For each={displayedNodes()}>
                {(node) => (
                  <SubagentRow context={context} session={node.session} node={node} />
                )}
              </For>
              <Show when={nodes().length > MAX_VISIBLE_SUBAGENTS}>
                <box
                  width="100%"
                  backgroundColor={
                    moreHovered() ? raisedBg() : context.theme.background.base
                  }
                  onMouseOver={() => setMoreHovered(true)}
                  onMouseOut={() => setMoreHovered(false)}
                  onMouseDown={expand}
                >
                  <text
                    fg={moreHovered() ? context.theme.text.base : context.theme.text.muted}
                    wrapMode="none"
                  >
                    +{nodes().length - MAX_VISIBLE_SUBAGENTS} more
                  </text>
                </box>
              </Show>
            </box>
          }
        >
          <scrollbox
            width="100%"
            height={Math.min(MAX_EXPANDED_HEIGHT, Math.max(2, nodes().length * 2))}
            scrollY={true}
          >
            <box flexDirection="column" width="100%" minWidth={0}>
              <For each={nodes()}>
                {(node) => <SubagentRow context={context} session={node.session} node={node} />}
              </For>
            </box>
          </scrollbox>
          <box
            border={true}
            borderColor={context.theme.text.muted}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={
              collapseHovered() ? raisedBg() : context.theme.background.base
            }
            onMouseOver={() => setCollapseHovered(true)}
            onMouseOut={() => setCollapseHovered(false)}
            onMouseDown={collapse}
          >
            <text
              fg={collapseHovered() ? context.theme.text.base : context.theme.text.muted}
              wrapMode="none"
            >
              Collapse subagents
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function syncMessages(context: Context, sessionID: string, state: SyncState): void {
  if (state.messages.has(sessionID)) return
  state.messages.add(sessionID)
  void context.data.session.message.sync(sessionID).catch(() => state.messages.delete(sessionID))
}

function syncChildren(context: Context, sessionID: string, state: SyncState): void {
  if (state.children.has(sessionID)) return
  state.children.add(sessionID)

  void context.client.session
    .list({ parentID: sessionID, order: "desc" })
    .then((response) =>
      Promise.all(
        response.data.map(async (child) => {
          await context.data.session.sync(child.id)
          syncChildren(context, child.id, state)
        }),
      ),
    )
    .catch(() => state.children.delete(sessionID))
}

export default Plugin.define({
  id: "subagent-sidebar-tree",
  setup(context) {
    let disposed = false
    const syncState: SyncState = {
      children: new Set(),
      messages: new Set(),
    }

    const syncParent = (sessionID: string | undefined) => {
      if (!sessionID || disposed) return
      syncChildren(context, sessionID, syncState)
    }

    // A continued/resumed child keeps its original `title`; only the PARENT's
    // newest Task tool call carries the new text. Force a refresh of the session
    // record AND its parent's messages on real V2 events so the sidebar never
    // renders a stale title.
    const refreshSession = (id: unknown) => {
      if (disposed || typeof id !== "string") return
      try {
        const invalidate = (
          context.data.session as unknown as {
            invalidate?: (sessionID: string) => void
          }
        ).invalidate
        invalidate?.(id)
      } catch {
        /* `invalidate` is optional across V2 builds */
      }
      syncState.children.delete(id)
      syncState.messages.delete(id)
      try {
        void context.data.session.sync(id).catch(() => {})
      } catch {
        /* best-effort */
      }
      try {
        const parentID = (
          context.data.session.get(id) as { parentID?: string } | undefined
        )?.parentID
        if (parentID) {
          syncState.messages.delete(parentID)
          void context.data.session.message.sync(parentID).catch(() => {})
        }
      } catch {
        /* parent lookup is best-effort */
      }
    }

    const onEvent = context.data.on as unknown as (
      type: string,
      handler: (event: { data?: { sessionID?: unknown; parentID?: unknown } }) => void,
    ) => () => void

    const subscribe = (
      type: string,
      handler: (event: { data?: { sessionID?: unknown; parentID?: unknown } }) => void,
    ): (() => void) => {
      try {
        return onEvent(type, handler)
      } catch {
        return () => {}
      }
    }

    const stopCreated = context.data.on("session.created", (event) => {
      syncParent(event.data.parentID)
    })

    const stopStatus = context.data.on("session.status", (event) => {
      syncParent(event.data.sessionID)
    })

    // `session.status` is still declared in the V2 SDK (data.status.type
    // busy/retry/idle), so it is left in place. The live v2.0.6 stream also emits
    // `session.execution.*` (verified via the keep-awake plugin); subscribe to
    // those and `session.renamed` too, so a continued child is never stale.
    const stopRenamed = subscribe("session.renamed", (event) =>
      refreshSession(event.data?.sessionID),
    )
    const stopExecStarted = subscribe("session.execution.started", (event) =>
      refreshSession(event.data?.sessionID),
    )
    const stopExecSucceeded = subscribe("session.execution.succeeded", (event) =>
      refreshSession(event.data?.sessionID),
    )
    const stopExecFailed = subscribe("session.execution.failed", (event) =>
      refreshSession(event.data?.sessionID),
    )
    const stopExecInterrupted = subscribe("session.execution.interrupted", (event) =>
      refreshSession(event.data?.sessionID),
    )

    const unregister = context.ui.slot({
      prepend: "sidebar.content",
      render: ({ sessionID }) => (
        <SidebarSubagents context={context} sessionID={sessionID} syncState={syncState} />
      ),
    })

    return () => {
      disposed = true
      stopCreated()
      stopStatus()
      stopRenamed()
      stopExecStarted()
      stopExecSucceeded()
      stopExecFailed()
      stopExecInterrupted()
      unregister()
    }
  },
})
