/**
 * Unified-host test for the subagent family tree.
 *
 * The plugin contributes the SAME tree to two host slots:
 *   - `sidebar.content` (the core 42-col sidebar), and
 *   - `session.panel` (the right-pane panel), opened by the route watcher.
 *
 * Which one should render depends on the HOST, and the host is not queryable
 * from a plugin:
 *   - Stock v2.0.22 gates the core sidebar off for subagent (`parentID`)
 *     sessions in `sidebarVisible()` (`session-frame.tsx`), so `sidebar.content`
 *     never renders for a subagent and the panel must be opened.
 *   - The patched/ungated build renders the core sidebar for subagents, so the
 *     tree belongs in the sidebar and the panel must NOT be opened.
 *
 * The plugin detects the host by recording whether its own `sidebar.content`
 * contribution actually mounted for the current route (`SubagentSidebar`'s
 * tracking effect). The host gives an active panel precedence over the sidebar
 * (`rightPane()` checks `activePanel()` first), so the two are mutually
 * exclusive and the panel is only opened after a one-macrotask defer.
 *
 * This test reproduces that mutual exclusivity with the real `SubagentSidebar`,
 * `SubagentPanel` and `SubagentPanelAutoOpen` components and asserts:
 *   - GATED host  -> tree in the panel, no sidebar, panel opened;
 *   - UNGATED host -> tree in the sidebar, NO panel, panel not opened;
 *   - UNGATED navigation -> the per-route tracking still suppresses the panel.
 */
/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import {
  openPanelIfSidebarAbsent,
  resetSidebarRenderTracking,
  SubagentPanel,
  SubagentPanelAutoOpen,
  SubagentSidebar,
} from "../tui"

const WIDTH = 140
const HEIGHT = 30
/** Core `SESSION_SIDEBAR_WIDTH` (packages/tui/src/component/session-frame.tsx). */
const SIDEBAR_WIDTH = 42
/** Harness right-pane width (host sizes the panel to ~50% of the terminal). */
const PANEL_WIDTH = 70
const PANEL_NAME = "subagent-tree"

const color = RGBA.fromInts(200, 200, 200)
const muted = RGBA.fromInts(120, 120, 120)
const raised = RGBA.fromInts(30, 30, 30)

type MockSession = {
  id: string
  parentID?: string
  agent?: string
  title?: string
  time: { updated: number }
}

const SESSIONS: MockSession[] = [
  { id: "ses_root", agent: "build", title: "Root", time: { updated: 100 } },
  { id: "ses_child", parentID: "ses_root", agent: "explore", title: "Child", time: { updated: 40 } },
  { id: "ses_sibling", parentID: "ses_root", agent: "general", title: "Sibling", time: { updated: 30 } },
  { id: "ses_grand", parentID: "ses_child", agent: "plan", title: "Grandchild", time: { updated: 50 } },
]

type PanelState = {
  opened: string[]
  setPanelOpen: (value: boolean) => void
}

function makeContext(getSessionID: () => string, panel: PanelState): Context {
  const byID = new Map(SESSIONS.map((session) => [session.id, session]))
  return {
    theme: {
      background: { base: raised, raised: { base: raised }, default: raised, surface: { offset: raised } },
      text: {
        base: color,
        muted,
        subdued: muted,
        feedback: {
          success: { base: RGBA.fromInts(0, 200, 0) },
          error: { base: RGBA.fromInts(200, 0, 0) },
          warning: { base: RGBA.fromInts(200, 150, 0) },
        },
      },
      hue: { neutral: { 300: muted, 400: muted, 500: muted } },
      scrollbar: { base: muted },
      categorical: [],
    },
    data: {
      session: {
        list: () => SESSIONS,
        get: (id: string) => byID.get(id),
        root: () => "ses_root",
        status: () => "running",
        sync: async () => {},
        message: { list: () => [], sync: async () => {} },
      },
      location: { model: { list: () => undefined }, agent: { list: () => [] } },
    },
    client: { session: { list: async () => ({ data: [] }) } },
    ui: {
      router: {
        current: () => ({ type: "session", sessionID: getSessionID() }),
        navigate: () => {},
      },
      panel: {
        open: (name: string) => {
          panel.opened.push(name)
          panel.setPanelOpen(true)
          return true
        },
        close: () => panel.setPanelOpen(false),
        current: () => undefined,
      },
    },
    renderer: { terminalWidth: 200 },
  } as unknown as Context
}

/**
 * Faithful reproduction of the host's right-pane precedence:
 *   session pane (left) + core sidebar (when `!gated` and no panel) OR
 *   right-pane panel (when a panel is active). The host never renders the
 *   sidebar while its panel is active (`rightPane()` checks `activePanel()`
 *   first), which is exactly why the plugin must decide BEFORE opening.
 */
function Harness(props: {
  context: Context
  sessionID: () => string
  syncState: { children: Set<string>; messages: Set<string> }
  gated: boolean
  panelOpen: () => boolean
}) {
  return (
    <box width={WIDTH} height={HEIGHT} flexDirection="column">
      <box flexGrow={1} minHeight={0} flexDirection="row" position="relative">
        <box id="session-pane" flexGrow={1} flexBasis={0} minWidth={0} minHeight={0} flexDirection="column">
          <text id="main-marker">MAIN PANEL CONTENT</text>
        </box>
        <box id="right-pane" flexShrink={0} width={PANEL_WIDTH} height="100%" flexDirection="column">
          {/* The host's `rightPane()` is "panel" when a panel is active... */}
          <Show when={props.panelOpen()}>
            <box
              id="session-panel"
              flexGrow={1}
              minWidth={0}
              minHeight={0}
              flexDirection="column"
              focusable
              backgroundColor={raised}
            >
              <SubagentPanel
                context={props.context}
                sessionID={props.sessionID()}
                syncState={props.syncState}
              />
            </box>
          </Show>
          {/* ...otherwise "sidebar" (ungated host only) or nothing (gated). */}
          <Show when={!props.gated && !props.panelOpen()}>
            <box id="core-sidebar" width={SIDEBAR_WIDTH} height="100%" flexDirection="column">
              <SubagentSidebar
                context={props.context}
                sessionID={props.sessionID()}
                syncState={props.syncState}
              />
            </box>
          </Show>
        </box>
      </box>
      <SubagentPanelAutoOpen context={props.context} syncState={props.syncState} />
    </box>
  )
}

async function settle(app: { flush: () => Promise<void> }) {
  // Let the deferred (setTimeout 0) panel decision fire, then commit the frame.
  await new Promise((resolve) => setTimeout(resolve, 30))
  await app.flush()
  await app.flush()
}

async function renderHost(gated: boolean, initialSessionID: string) {
  resetSidebarRenderTracking()
  const panel: PanelState = { opened: [], setPanelOpen: () => {} }
  const [sessionID, setSessionID] = createSignal(initialSessionID)
  const [panelOpen, setPanelOpen] = createSignal(false)
  panel.setPanelOpen = setPanelOpen
  const context = makeContext(sessionID, panel)
  const syncState = { children: new Set<string>(), messages: new Set<string>() }
  const app = await testRender(
    () => (
      <Harness
        context={context}
        sessionID={sessionID}
        syncState={syncState}
        gated={gated}
        panelOpen={panelOpen}
      />
    ),
    { width: WIDTH, height: HEIGHT },
  )
  await settle(app)
  return { app, panel, setSessionID }
}

/** Column (0-based) of `needle` on its line, or -1. */
function columnOf(frame: string, needle: string): number {
  for (const line of frame.split("\n")) {
    const at = line.indexOf(needle)
    if (at >= 0) return at
  }
  return -1
}

/** 0-based index of the first line containing `needle`, or -1. */
function lineIndexOf(frame: string, needle: string): number {
  const lines = frame.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) return index
  }
  return -1
}

function node(app: any, id: string) {
  return app.renderer.root.findDescendantById(id) ?? undefined
}

test("gated host: subagent tree renders in the PANEL, not the sidebar", async () => {
  const { app, panel } = await renderHost(true, "ses_child")
  try {
    const right = node(app, "right-pane")!
    const subagentPanel = node(app, "subagent-panel")!
    expect(subagentPanel).toBeDefined()
    expect(panel.opened).toEqual([PANEL_NAME])

    const frame = app.captureCharFrame()
    // (a) the panel's tree header + rows render in the right pane, with the
    // MAIN/ROOT row first and no aggregate header.
    expect(frame).toContain("Subagent tree")
    expect(frame).toContain("build")
    expect(frame).not.toContain("SUBAGENTS (")
    expect(frame).toContain("explore")
    expect(frame).toContain("general")
    expect(frame).toContain("plan")
    expect(columnOf(frame, "build")).toBeGreaterThanOrEqual(right.x)
    expect(columnOf(frame, "explore")).toBeGreaterThanOrEqual(right.x)
    expect(lineIndexOf(frame, "build")).toBeLessThan(lineIndexOf(frame, "explore"))

    // (b) no core sidebar contribution rendered for the subagent.
    expect(node(app, "subagent-sidebar")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("ungated host: subagent tree renders in the SIDEBAR and NO panel opens", async () => {
  const { app, panel } = await renderHost(false, "ses_child")
  try {
    const sidebar = node(app, "core-sidebar")!
    expect(sidebar).toBeDefined()
    expect(node(app, "subagent-sidebar")).toBeDefined()

    // The host's panel was never opened (no duplicate tree).
    expect(panel.opened).toEqual([])
    expect(node(app, "subagent-panel")).toBeUndefined()
    expect(node(app, "session-panel")).toBeUndefined()

    const frame = app.captureCharFrame()
    expect(frame).toContain("build")
    expect(frame).not.toContain("SUBAGENTS (")
    expect(frame).toContain("explore")
    expect(columnOf(frame, "build")).toBeGreaterThanOrEqual(sidebar.x)
    expect(lineIndexOf(frame, "build")).toBeLessThan(lineIndexOf(frame, "explore"))
    // The panel-only header must be absent: the tree lives in the sidebar.
    expect(frame).not.toContain("Subagent tree")
  } finally {
    app.renderer.destroy()
  }
})

test("ungated host: navigation keeps the tree in the sidebar (per-route tracking)", async () => {
  const { app, panel, setSessionID } = await renderHost(false, "ses_child")
  try {
    expect(node(app, "subagent-sidebar")).toBeDefined()
    setSessionID("ses_sibling")
    await settle(app)

    expect(panel.opened).toEqual([])
    expect(node(app, "core-sidebar")).toBeDefined()
    expect(node(app, "subagent-sidebar")).toBeDefined()
    const frame = app.captureCharFrame()
    expect(frame).toContain("build")
    expect(frame).not.toContain("SUBAGENTS (")
    expect(frame).not.toContain("Subagent tree")
  } finally {
    app.renderer.destroy()
  }
})

test("openPanelIfSidebarAbsent: skips the panel when the sidebar rendered for the session", async () => {
  resetSidebarRenderTracking()
  const panel: PanelState = { opened: [], setPanelOpen: () => {} }
  const [sessionID] = createSignal("ses_child")
  const context = makeContext(sessionID, panel)
  const app = await testRender(
    () => (
      <SubagentSidebar
        context={context}
        sessionID="ses_child"
        syncState={{ children: new Set<string>(), messages: new Set<string>() }}
      />
    ),
    { width: WIDTH, height: HEIGHT },
  )
  try {
    await app.flush()
    openPanelIfSidebarAbsent(context, "ses_child", "ses_root", "test")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(panel.opened).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("openPanelIfSidebarAbsent: a stale timer never opens the panel for a different route", async () => {
  resetSidebarRenderTracking()
  const panel: PanelState = { opened: [], setPanelOpen: () => {} }
  let routeSessionID = "ses_child"
  const context = {
    renderer: { terminalWidth: 200 },
    ui: {
      router: { current: () => ({ type: "session", sessionID: routeSessionID }) },
      panel: {
        open: (name: string) => {
          panel.opened.push(name)
          return true
        },
      },
    },
  } as unknown as Context

  openPanelIfSidebarAbsent(context, "ses_child", "ses_root", "test")
  routeSessionID = "ses_root" // navigate away before the macrotask fires
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(panel.opened).toEqual([])
})

test("openPanelIfSidebarAbsent: narrow terminal keeps the panel closed (guard preserved)", async () => {
  resetSidebarRenderTracking()
  const panel: PanelState = { opened: [], setPanelOpen: () => {} }
  const context = {
    renderer: { terminalWidth: 80 },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_child" }) },
      panel: {
        open: (name: string) => {
          panel.opened.push(name)
          return true
        },
      },
    },
  } as unknown as Context

  openPanelIfSidebarAbsent(context, "ses_child", "ses_root", "test")
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(panel.opened).toEqual([])
})
