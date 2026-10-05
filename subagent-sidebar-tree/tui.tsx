/** @jsxImportSource @opentui/solid */

import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
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
// Subtle brightening of the side panel background (#141414) for the currently-viewed subagent row
const CURRENT_HIGHLIGHT_BG = "#1e1e1e"

const FALLBACK_PALETTE: readonly string[] = [
  "#5c9cf5", // blue
  "#9d7cd8", // purple
  "#7fd88f", // green
  "#fab283", // orange
  "#e06c75", // red
  "#56b6c2", // cyan
]

const PLUGIN_ID = "subagent-sidebar-tree"
/** Panel name registered in `session.panel`; contributions gate on it. */
const PANEL_NAME = "subagent-tree"
/**
 * Core right-sidebar width (`SESSION_SIDEBAR_WIDTH` in
 * `packages/tui/src/component/session-frame.tsx`). The `session.panel` right
 * pane does NOT use this value — the host sizes it to ~50% of the terminal —
 * so it is only logged for comparison, never assumed.
 */
const SESSION_SIDEBAR_WIDTH = 42
/**
 * The host forces a panel fullscreen when the terminal is at or below this
 * width (`canSplit = () => width() > 80` in
 * `packages/tui/src/context/panel.tsx`). In fullscreen `pane.focus.left` is
 * disabled and the prompt cannot be refocused, so the plugin must not open the
 * panel on a narrow terminal (it would trap focus).
 */
const MIN_PANEL_TERMINAL_WIDTH = 80
const LIVE_LOG_PATH =
  process.env.SUBAGENT_TREE_LOG ?? join(tmpdir(), "subagent-sidebar-tree-live.log")

/**
 * Best-effort live log for diagnosing the right-pane panel at runtime. Every
 * call is wrapped so a missing path or a locked file can never break the
 * plugin. Format: `<ISO timestamp> <message>`.
 */
function logLive(message: string): void {
  try {
    appendFileSync(LIVE_LOG_PATH, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* best-effort: logging must never break the plugin */
  }
}

// Panel-open / tree-render / width logging is deduped per session so reactive
// re-renders do not spam the log. All are cleared on every activation.
const loggedPanelOpens = new Set<string>()
const loggedPanelTrees = new Set<string>()
const loggedPanelWidths = new Set<string>()

/**
 * Session IDs the host is CURRENTLY rendering the core sidebar for.
 *
 * This is the plugin's capability probe for "does this host render the core
 * sidebar for this session?". The `sidebar.content` slot's render callback only
 * runs when the host actually mounts the sidebar, and stock v2.0.22 gates the
 * sidebar off for `parentID` sessions in `sidebarVisible()`. So a subagent ID
 * is present here iff the running host is the patched/ungated build that serves
 * subagents from the core sidebar.
 *
 * `SubagentSidebar` adds the current route's ID on mount/route change and its
 * effect-local `onCleanup` removes the previous ID on navigation and the
 * current one on unmount, so membership means "rendered right now", never
 * "rendered at some point". Cleared on every activation.
 */
const sidebarRenderedSessions = new Set<string>()

/**
 * Test/debug hook: forget every recorded sidebar render. The live plugin clears
 * this on activation; tests call it between simulated host modes so one mode's
 * render cannot leak into the next.
 */
export function resetSidebarRenderTracking(): void {
  sidebarRenderedSessions.clear()
}

/**
 * Opens the right-pane panel, but only when the terminal is wide enough for the
 * host to split it. When `terminalWidth <= 80` the host forces the panel
 * fullscreen (`canSplit = () => width() > 80` in
 * `packages/tui/src/context/panel.tsx`); in fullscreen `pane.focus.left` is
 * disabled and `focusSession()` early-returns, so the prompt cannot be
 * refocused (a focus trap). `context.renderer.terminalWidth` is the only
 * plugin-accessible width read, so skip the open when it is unknown or too
 * small. The host-assigned pane width cannot be set from a plugin (there is no
 * width option on `ui.panel.open` and no pane-resize command).
 */
export function openPanelGuarded(context: Context, sessionID: string, parentID: string, source: string): void {
  try {
    const width = context.renderer.terminalWidth
    if (!(width > MIN_PANEL_TERMINAL_WIDTH)) {
      logLive(`panel.skip sessionID=${sessionID} reason=narrow-terminal width=${width}`)
      return
    }
    if (context.ui.panel.open(PANEL_NAME) && !loggedPanelOpens.has(sessionID)) {
      loggedPanelOpens.add(sessionID)
      logLive(`panel.open sessionID=${sessionID} parentID=${parentID} width=${width}`)
    }
  } catch (error) {
    logLive(`panel.open ${source} error=${String(error)}`)
  }
}

/**
 * Opens the right-pane panel for a subagent session ONLY when the host did not
 * render the core sidebar for it.
 *
 * The decision is deferred one macrotask so the host can commit the route's
 * render and effects first: on the patched host the sidebar (and therefore
 * `SubagentSidebar`) mounts synchronously with the frame and records the
 * session; on stock v2.0.22 it never mounts. This is deliberately NOT
 * "close the panel if the sidebar renders": the host gives an active panel
 * precedence over the sidebar (`rightPane()` in `session-frame.tsx`), so once
 * the panel opened the sidebar would never render and the duplicate could not
 * be detected.
 *
 * The callback also re-checks the live route before opening, so a timer left
 * over from a previous navigation can never open the panel for a different
 * (possibly root) session. Returns the timer so callers can cancel it.
 */
export function openPanelIfSidebarAbsent(
  context: Context,
  sessionID: string,
  parentID: string,
  source: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    try {
      const route = context.ui.router.current()
      if (route.type !== "session" || route.sessionID !== sessionID) return
    } catch {
      return
    }
    if (sidebarRenderedSessions.has(sessionID)) {
      logLive(`panel.skip sessionID=${sessionID} reason=core-sidebar-rendered source=${source}`)
      return
    }
    openPanelGuarded(context, sessionID, parentID, source)
  }, 0)
}

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
  waiting: "waiting",
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

function SubagentRow(props: { context: Context; session: SubagentSession; node: SubagentTreeNode; currentSessionID?: string }) {
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
    // running/waiting -> green, failed -> red, stopped -> orange, done/idle -> mute grey
    if (value === "running" || value === "waiting") {
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

  const isCurrent = () => props.currentSessionID === props.session.id

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
        {/* Styled runs inside <text> must be <span> (a TextNodeRenderable); a
            nested <text> is a TextRenderable and throws in TextNodeRenderable.add. */}
        <span style={{ get bg() { return isCurrent() ? CURRENT_HIGHLIGHT_BG : undefined }, get fg() { return isCurrent() ? baseColor() : undefined } }}>
          {shorten(
            latestTaskDescription(parentMessages(), props.session.id) ||
              session().title ||
              subagentTask(messages(), activity()),
            Math.max(8, 48 - width()),
          )}
        </span>
      </text>
    </box>
  )
}

function SidebarSubagents(props: {
  context: Context
  sessionID: string
  syncState: SyncState
  overlay?: boolean
  currentSessionID?: string
  /** Optional observer for the flattened tree; used by the right-pane panel to log what rendered. */
  onNodes?: (nodes: SubagentTreeNode[]) => void
}) {
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

  // Let a host (the right-pane panel) observe what actually rendered. The
  // callback is expected to dedupe; this effect re-runs on every tree change.
  createEffect(() => {
    props.onNodes?.(nodes())
  })

  createEffect(() => {
    try {
      const timer = setInterval(() => setNow(Date.now()), 5000)
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
      <box
        flexDirection="column"
        paddingBottom={1}
        paddingTop={props.overlay ? 1 : 0}
        paddingLeft={props.overlay ? 2 : 0}
        paddingRight={props.overlay ? 2 : 0}
        backgroundColor={props.overlay ? raisedBg() : undefined}
      >
        <text fg={context.theme.text.base} wrapMode="none">
          SUBAGENTS ({nodes().length})
        </text>
        <Show
          when={expanded()}
          fallback={
            <box flexDirection="column">
              <For each={displayedNodes()}>
                {(node) => (
                  <SubagentRow context={context} session={node.session} node={node} currentSessionID={props.currentSessionID} />
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
                {(node) => <SubagentRow context={context} session={node.session} node={node} currentSessionID={props.currentSessionID} />}
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

/**
 * Subagent family tree contributed to the core right sidebar.
 *
 * The core `Sidebar` (and therefore the `sidebar.content` slot) owns the
 * sidebar's width, background, padding and scroll region and lays the sidebar
 * out as a flex sibling of the session pane
 * (`packages/tui/src/component/session-frame.tsx`), so the host resizes the
 * main panel to make room instead of the plugin overlaying it.
 *
 * On the patched/ungated host the sidebar renders for subagent sessions too,
 * so this is where the tree belongs. On stock v2.0.22 the host gates the
 * sidebar off for `parentID` sessions (`sidebarVisible()`) and `SubagentPanel`
 * takes over. The tracking effect below is what tells the two apart; see
 * `openPanelIfSidebarAbsent`.
 *
 * The whole family is shown (the root's descendants: parent, siblings and
 * children of the current session), not just the current session's own
 * children, so the user sees where they are in the tree.
 */
export function SubagentSidebar(props: { context: Context; sessionID: string; syncState: SyncState }) {
  // The host invokes this slot's render ONLY when it actually mounts the core
  // sidebar, so recording the current route session here is the direct signal
  // `openPanelIfSidebarAbsent` uses to decide whether the sidebar already serves
  // this session. `onCleanup` inside the effect removes the previous ID when the
  // route changes and the current one when the sidebar unmounts.
  createEffect(() => {
    const id = props.sessionID
    sidebarRenderedSessions.add(id)
    onCleanup(() => sidebarRenderedSessions.delete(id))
  })

  const familyRoot = () => {
    try {
      return props.context.data.session.root(props.sessionID)
    } catch {
      return props.sessionID
    }
  }

  return (
    <box id="subagent-sidebar" flexDirection="column" width="100%">
      <SidebarSubagents
        context={props.context}
        sessionID={familyRoot()}
        syncState={props.syncState}
        currentSessionID={props.sessionID}
      />
    </box>
  )
}

/**
 * Subagent family tree contributed to the right-pane `session.panel` slot.
 *
 * The core sidebar is gated off for subagent (`parentID`) sessions on v2.0.22,
 * so `sidebar.content` never mounts for them. This panel is the fallback: the
 * host renders `session.panel` in the right pane for whatever session route is
 * active, so registering here puts the tree in the right pane for subagents.
 * It reuses the same `SidebarSubagents` tree and `syncChildren`/`syncMessages`
 * wiring as the sidebar, so both hosts stay in lockstep.
 *
 * Focus tradeoff: the host focuses the panel node on mount (`PanelHost`'s
 * `onMount` -> `onTarget` -> `focusRightPane` -> `panelNode.focus()`), stealing
 * focus from the prompt. There is no `ui.focus` API and no way to suppress that
 * focus steal, so after the panel mounts we dispatch the host's
 * `pane.focus.left` command, which blurs the right pane and refocuses the
 * prompt. That command is only enabled while `activePanel() !== undefined`
 * (true once this panel is mounted), and `setTimeout` defers the dispatch past
 * the host's synchronous mount-time focus call.
 */
export function SubagentPanel(props: { context: Context; sessionID: string; syncState: SyncState }) {
  const familyRoot = () => {
    try {
      return props.context.data.session.root(props.sessionID)
    } catch {
      return props.sessionID
    }
  }

  const logTree = (nodes: SubagentTreeNode[]) => {
    if (loggedPanelTrees.has(props.sessionID)) return
    loggedPanelTrees.add(props.sessionID)
    const labels = nodes
      .slice(0, 4)
      .map((node) => sessionLabel(node.session))
      .join(",")
    logLive(`panel.tree sessionID=${props.sessionID} nodes=${nodes.length} labels=${labels}`)
  }

  onMount(() => {
    const timer = setTimeout(() => {
      try {
        props.context.keymap?.dispatch("pane.focus.left")
        logLive(`panel.focus sessionID=${props.sessionID} dispatch=pane.focus.left`)
      } catch (error) {
        logLive(`panel.focus sessionID=${props.sessionID} error=${String(error)}`)
      }
    }, 50)
    onCleanup(() => clearTimeout(timer))
  })

  return (
    <box id="subagent-panel" flexDirection="column" width="100%" height="100%">
      <box flexShrink={0} paddingBottom={1}>
        <text fg={props.context.theme.text.base} wrapMode="none">
          Subagent tree
        </text>
      </box>
      <SidebarSubagents
        context={props.context}
        sessionID={familyRoot()}
        syncState={props.syncState}
        currentSessionID={props.sessionID}
        onNodes={logTree}
      />
    </box>
  )
}

/**
 * Headless route watcher that opens the right-pane panel for subagent sessions
 * ONLY when the core sidebar is not serving the session (see
 * `openPanelIfSidebarAbsent`).
 *
 * The plugin `Context` exposes no route subscription (`ui.router` only has
 * `register` / `navigate` / `current`), so this is mounted into the
 * always-present `app` slot. `ui.router.current()` reads the host's route
 * store, so a `createEffect` re-runs on every navigation; there is no invented
 * API. Root sessions are left alone (the panel is session-scoped and the host
 * hides it on other routes anyway). Exported so the both-host-mode render test
 * can drive the real watcher.
 */
export function SubagentPanelAutoOpen(props: { context: Context; syncState: SyncState }) {
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    try {
      const route = props.context.ui.router.current()
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (route.type !== "session") return
      const session = props.context.data.session.get(route.sessionID) as
        | { parentID?: string }
        | undefined
      if (!session?.parentID) return
      timer = openPanelIfSidebarAbsent(props.context, route.sessionID, session.parentID, "watcher")
    } catch (error) {
      logLive(`panel.open watcher error=${String(error)}`)
    }
  })
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return null
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

    // Fresh dedupe state for this activation.
    loggedPanelOpens.clear()
    loggedPanelTrees.clear()
    loggedPanelWidths.clear()
    sidebarRenderedSessions.clear()

    try {
      const initialRoute = context.ui.router.current()
      const initialSessionID = initialRoute.type === "session" ? initialRoute.sessionID : undefined
      logLive(
        `activation plugin=${PLUGIN_ID} route=${initialRoute.type}` +
          (initialSessionID ? ` sessionID=${initialSessionID}` : ""),
      )
    } catch (error) {
      logLive(`activation plugin=${PLUGIN_ID} error=${String(error)}`)
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

    // Root sessions keep the tree in the core sidebar (`sidebar.content`).
    // v2.0.22 gates that sidebar off for `parentID` sessions, so the panel
    // registration below is the fallback that renders the same tree in the
    // right pane for subagents.
    const unregisterSidebar = context.ui.slot({
      prepend: "sidebar.content",
      render: ({ sessionID }) => (
        <SubagentSidebar context={context} sessionID={sessionID} syncState={syncState} />
      ),
    })

    // The right-pane `session.panel` slot. The host renders it for whichever
    // panel is active, so gate on the panel name: other plugins' panels must
    // not get our tree injected into them.
    const unregisterPanel = context.ui.slot({
      prepend: "session.panel",
      render: (input) => {
        if (input.name === PANEL_NAME) {
          try {
            const width = input.width
            const key = `${input.sessionID}:${width}`
            if (!loggedPanelWidths.has(key)) {
              loggedPanelWidths.add(key)
              logLive(
                `panel.width sessionID=${input.sessionID} width=${width} sidebarWidth=${SESSION_SIDEBAR_WIDTH} delta=${width - SESSION_SIDEBAR_WIDTH}`,
              )
            }
          } catch (error) {
            logLive(`panel.width error=${String(error)}`)
          }
        }
        return (
          <Show when={input.name === PANEL_NAME}>
            <SubagentPanel context={context} sessionID={input.sessionID} syncState={syncState} />
          </Show>
        )
      },
    })

    // `ui.router` exposes no route subscription, so open the panel for
    // subagent routes through a headless watcher in the always-mounted `app`
    // slot (see SubagentPanelAutoOpen). This covers both the initial route and
    // later navigation into a subagent.
    const unregisterPanelAutoOpen = context.ui.slot({
      prepend: "app",
      render: () => <SubagentPanelAutoOpen context={context} syncState={syncState} />,
    })

    // Also attempt the initial open directly from setup. `ui.panel.open`
    // returns false until the registration is marked active, which happens
    // after setup returns, so defer to the next macrotask. The watcher above
    // would cover this too; both calls are idempotent and both go through the
    // same sidebar-render check, so neither opens a duplicate.
    let initialOpenTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const route = context.ui.router.current()
      if (route.type === "session") {
        const session = context.data.session.get(route.sessionID) as
          | { parentID?: string }
          | undefined
        if (session?.parentID) {
          initialOpenTimer = openPanelIfSidebarAbsent(
            context,
            route.sessionID,
            session.parentID,
            "initial",
          )
        }
      }
    } catch (error) {
      logLive(`panel.open error=${String(error)}`)
    }

    return () => {
      disposed = true
      if (initialOpenTimer) clearTimeout(initialOpenTimer)
      stopCreated()
      stopStatus()
      stopRenamed()
      stopExecStarted()
      stopExecSucceeded()
      stopExecFailed()
      stopExecInterrupted()
      unregisterSidebar()
      unregisterPanel()
      unregisterPanelAutoOpen()
    }
  },
})
