/**
 * Visibility test for the subagent sidebar tree.
 *
 * The host's `session-frame.tsx` renders the core `Sidebar` (and therefore the
 * `sidebar.content` slot) for every session, including subagents, and lays the
 * sidebar out as a flex sibling of the session pane. The plugin contributes the
 * family tree to `sidebar.content`; the host resizes the main panel to make
 * room instead of the plugin overlaying it.
 *
 * This test reproduces the real layout nesting from `packages/tui/src/app.tsx`,
 * `component/session-frame.tsx` and `routes/session/index.tsx`, renders the
 * ACTUAL `SubagentSidebar` component (the same component the plugin registers)
 * into the core sidebar's `sidebar.content` position, and asserts on the
 * laid-out renderables and the captured character frame:
 *
 *   1. the sidebar is a real flex sibling pinned to the right edge at the
 *      sidebar width and full height,
 *   2. the main panel is RESIZED to the left of it (not covered),
 *   3. the bottom panel is visible to the left (not covered),
 *   4. the sidebar contains the subagent family tree,
 *   5. the sidebar does not overlap the main or bottom panel.
 */
/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SubagentSidebar } from "../tui"

const WIDTH = 140
const HEIGHT = 30
const SIDEBAR_WIDTH = 42

const color = RGBA.fromInts(200, 200, 200)
const muted = RGBA.fromInts(120, 120, 120)
const raised = RGBA.fromInts(30, 30, 30)

type MockSession = {
  id: string
  parentID?: string
  agent?: string
  title?: string
  time: { updated: number }
  location?: unknown
}

const SESSIONS: MockSession[] = [
  { id: "ses_root", agent: "build", title: "Root", time: { updated: 100 } },
  { id: "ses_child", parentID: "ses_root", agent: "explore", title: "Child", time: { updated: 40 } },
  { id: "ses_sibling", parentID: "ses_root", agent: "general", title: "Sibling", time: { updated: 30 } },
  { id: "ses_grand", parentID: "ses_child", agent: "plan", title: "Grandchild", time: { updated: 50 } },
]

function mockContext(currentSessionID: string): Context {
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
        current: () => ({ type: "session", sessionID: currentSessionID }),
        navigate: () => {},
      },
    },
  } as unknown as Context
}

/**
 * Faithful reproduction of the core nesting (host does NOT gate the sidebar for
 * `parentID` sessions):
 *   app root (column) -> main row (position: relative)
 *     -> A column -> B column -> SessionFrame (row)
 *          -> session pane (transcript + bottom panel)
 *          -> core Sidebar (flex sibling) -> sidebar.content -> SubagentSidebar
 */
function Harness(props: {
  context: Context
  sessionID: string
  syncState: { children: Set<string>; messages: Set<string> }
}) {
  return (
    <box width={WIDTH} height={HEIGHT} flexDirection="column">
      <box flexGrow={1} minHeight={0} flexDirection="row" position="relative">
        <box flexGrow={1} minWidth={0} flexDirection="column">
          <box flexGrow={1} minHeight={0} flexDirection="column">
            {/* SessionFrame: row, position relative */}
            <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="row" position="relative">
              <box
                id="session-pane"
                flexGrow={1}
                flexBasis={0}
                minWidth={0}
                minHeight={0}
                height="100%"
                flexDirection="column"
              >
                <box
                  flexGrow={1}
                  minHeight={0}
                  flexDirection="column"
                  paddingBottom={1}
                  paddingLeft={2}
                  paddingRight={2}
                >
                  <box id="transcript" flexGrow={1} minHeight={0} position="relative">
                    <text id="main-panel-marker">MAIN PANEL CONTENT</text>
                  </box>
                  <box flexShrink={0}>
                    <box id="bottom-panel">
                      <text id="bottom-panel-marker">BOTTOM PANEL SUBAGENTS TAB</text>
                    </box>
                  </box>
                </box>
              </box>
              {/* Core Sidebar (routes/session/sidebar.tsx), a flex sibling. */}
              <box
                id="core-sidebar"
                flexShrink={0}
                width={SIDEBAR_WIDTH}
                height="100%"
                flexDirection="column"
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={raised}
              >
                <scrollbox flexGrow={1} minHeight={0} scrollY={true}>
                  <box id="sidebar-content" flexShrink={0} gap={1} paddingRight={1}>
                    <SubagentSidebar
                      context={props.context}
                      sessionID={props.sessionID}
                      syncState={props.syncState}
                    />
                  </box>
                </scrollbox>
              </box>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}

async function render(sessionID: string) {
  const context = mockContext(sessionID)
  const syncState = { children: new Set<string>(), messages: new Set<string>() }
  const app = await testRender(() => <Harness context={context} sessionID={sessionID} syncState={syncState} />, {
    width: WIDTH,
    height: HEIGHT,
  })
  await app.renderOnce()
  return app
}

/** Column (0-based) of `needle` on its line, or -1. */
function columnOf(frame: string, needle: string): number {
  for (const line of frame.split("\n")) {
    const at = line.indexOf(needle)
    if (at >= 0) return at
  }
  return -1
}

function overlaps(a: { x: number; width: number }, b: { x: number; width: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x
}

function report(app: any) {
  const root = app.renderer.root
  const sidebar = root.findDescendantById("core-sidebar")!
  const pane = root.findDescendantById("session-pane")!
  const transcript = root.findDescendantById("transcript")!
  const bottom = root.findDescendantById("bottom-panel")!
  const inner = root.findDescendantById("subagent-sidebar")!
  console.log("\n===== layout (after fix: core sidebar is a flex sibling) =====")
  for (const [name, node] of Object.entries({ sidebar, pane, transcript, bottom, inner }) as [string, any][]) {
    console.log(`NODE ${name}: x=${node.x} y=${node.y} w=${node.width} h=${node.height}`)
  }
  console.log(
    `pane width ${pane.width}, sidebar x ${sidebar.x}: main panel ${overlaps(transcript, sidebar) ? "COVERED" : "NOT covered"}`,
  )
  const frame = app.captureCharFrame()
  const ruler = Array.from({ length: WIDTH }, (_, i) => (i % 10 === 0 ? String((i / 10) % 10) : " ")).join("")
  console.log("---- frame (ruler marks tens) ----")
  console.log(ruler)
  console.log(frame.split("\n").slice(0, 12).join("\n"))
}

test("subagent sidebar is a flex sibling: main + bottom panels resized, not covered", async () => {
  const app = await render("ses_child")
  try {
    report(app)

    const sidebar = app.renderer.root.findDescendantById("core-sidebar")!
    const pane = app.renderer.root.findDescendantById("session-pane")!
    const transcript = app.renderer.root.findDescendantById("transcript")!
    const bottom = app.renderer.root.findDescendantById("bottom-panel")!
    const inner = app.renderer.root.findDescendantById("subagent-sidebar")!

    // (1) pinned to the right edge, sidebar width, full height.
    expect(sidebar.x).toBe(WIDTH - SIDEBAR_WIDTH)
    expect(sidebar.x + sidebar.width).toBe(WIDTH)
    expect(sidebar.width).toBe(SIDEBAR_WIDTH)
    expect(sidebar.y).toBe(0)
    expect(sidebar.height).toBe(HEIGHT)

    // (2) the main panel is RESIZED to make room, not covered.
    expect(pane.x).toBe(0)
    expect(pane.width).toBe(WIDTH - SIDEBAR_WIDTH)
    expect(overlaps(transcript, sidebar)).toBe(false)
    expect(transcript.x + transcript.width).toBeLessThanOrEqual(sidebar.x)

    // (3) the bottom panel is visible to the left, not covered.
    expect(overlaps(bottom, sidebar)).toBe(false)
    expect(bottom.x + bottom.width).toBeLessThanOrEqual(sidebar.x)
    expect(bottom.height).toBeGreaterThan(0)

    const frame = app.captureCharFrame()

    // (4) the tree is rendered inside the sidebar.
    expect(inner).toBeDefined()
    expect(frame).toContain("SUBAGENTS (3)")
    expect(frame).toContain("explore")
    expect(frame).toContain("general")
    expect(frame).toContain("plan")
    expect(columnOf(frame, "SUBAGENTS (3)")).toBeGreaterThanOrEqual(sidebar.x)
    expect(columnOf(frame, "explore")).toBeGreaterThanOrEqual(sidebar.x)
    expect(columnOf(frame, "general")).toBeGreaterThanOrEqual(sidebar.x)

    // (5) the main + bottom panels are visible to the LEFT of the sidebar.
    expect(frame).toContain("MAIN PANEL CONTENT")
    expect(columnOf(frame, "MAIN PANEL CONTENT")).toBeGreaterThanOrEqual(0)
    expect(columnOf(frame, "MAIN PANEL CONTENT")).toBeLessThan(sidebar.x)
    expect(frame).toContain("BOTTOM PANEL SUBAGENTS TAB")
    expect(columnOf(frame, "BOTTOM PANEL SUBAGENTS TAB")).toBeGreaterThanOrEqual(0)
    expect(columnOf(frame, "BOTTOM PANEL SUBAGENTS TAB")).toBeLessThan(sidebar.x)
  } finally {
    app.renderer.destroy()
  }
})

test("root sessions also render the tree in the sidebar (no overlay)", async () => {
  const app = await render("ses_root")
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("SUBAGENTS (3)")
    expect(frame).toContain("MAIN PANEL CONTENT")
    expect(app.renderer.root.findDescendantById("subagent-sidebar")).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})
