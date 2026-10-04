/**
 * Right-pane panel test for the subagent family tree.
 *
 * On v2.0.22 the host gates the core sidebar (and therefore `sidebar.content`)
 * off for subagent (`parentID`) sessions, so the tree would not render there.
 * The plugin also contributes the same tree to the right-pane `session.panel`
 * slot; the host's `session-frame.tsx` lays that right pane out as a flex
 * sibling of the session pane (`flexShrink={0}`, fixed width, `PanelHost` ->
 * `session-panel` box -> `session.panel`).
 *
 * This test renders the ACTUAL exported `SubagentPanel` (the same component the
 * plugin registers) into a faithful reproduction of that right-pane layout and
 * asserts:
 *
 *   1. the tree text appears in the RIGHT PANE region,
 *   2. the main panel is RESIZED to the left of it (not covered), and
 *   3. the panel geometry sits inside the right-pane box.
 *
 * The current session is a SUBAGENT (`ses_child`, `parentID: "ses_root"`), the
 * case the sidebar cannot serve.
 */
/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SubagentPanel, openPanelGuarded } from "../tui"

const WIDTH = 140
const HEIGHT = 30
/**
 * Width the HARNESS assigns to its right-pane box. In the real host this is
 * `paneResize.size()` (~50% of the terminal), NOT the core sidebar's 42 cols;
 * 70 is exactly 50% of the 140-col harness terminal, so the measurement below
 * is deliberately distinct from `SIDEBAR_WIDTH` and cannot be mistaken for it.
 */
const PANEL_WIDTH = 70
/** Core `SESSION_SIDEBAR_WIDTH` (packages/tui/src/component/session-frame.tsx). */
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
      panel: { open: () => true, close: () => {}, current: () => undefined },
    },
  } as unknown as Context
}

/**
 * Faithful reproduction of the host's right-pane nesting
 * (`app.tsx` -> `session-frame.tsx` -> `PanelHost`):
 *   main row (row)
 *     -> session pane (flexGrow, transcript + bottom panel)
 *     -> right pane (flexShrink=0, fixed width)
 *          -> session-panel box (flexGrow, focusable)
 *               -> session.panel slot -> SubagentPanel
 */
function Harness(props: {
  context: Context
  sessionID: string
  syncState: { children: Set<string>; messages: Set<string> }
}) {
  return (
    <box width={WIDTH} height={HEIGHT} flexDirection="column">
      <box flexGrow={1} minHeight={0} flexDirection="row" position="relative">
        {/* SessionFrame's `session-pane`, resized to make room for the panel. */}
        <box
          id="session-pane"
          flexGrow={1}
          flexBasis={0}
          minWidth={0}
          minHeight={0}
          height="100%"
          flexDirection="column"
        >
          <box flexGrow={1} minHeight={0} flexDirection="column" paddingBottom={1} paddingLeft={2} paddingRight={2}>
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
        {/* SessionFrame's right pane; PanelHost renders `session.panel` inside. */}
        <box id="right-pane" flexShrink={0} width={PANEL_WIDTH} height="100%" minWidth={0} minHeight={0}>
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
              sessionID={props.sessionID}
              syncState={props.syncState}
            />
          </box>
        </box>
      </box>
    </box>
  )
}

async function render(sessionID: string) {
  const context = mockContext(sessionID)
  const syncState = { children: new Set<string>(), messages: new Set<string>() }
  const app = await testRender(
    () => <Harness context={context} sessionID={sessionID} syncState={syncState} />,
    { width: WIDTH, height: HEIGHT },
  )
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

test("subagent tree renders in the right pane for a subagent session", async () => {
  const app = await render("ses_child")
  try {
    const root = app.renderer.root
    const right = root.findDescendantById("right-pane")!
    const pane = root.findDescendantById("session-pane")!
    const transcript = root.findDescendantById("transcript")!
    const bottom = root.findDescendantById("bottom-panel")!
    const panel = root.findDescendantById("subagent-panel")!

    console.log("\n===== right-pane panel layout (subagent session) =====")
    for (const [name, node] of Object.entries({ right, pane, transcript, bottom, panel }) as [string, any][]) {
      console.log(`NODE ${name}: x=${node.x} y=${node.y} w=${node.width} h=${node.height}`)
    }

    // MEASURE the actual rendered right-pane width from the renderer's layout
    // tree (not from any plugin constant). This is the live proof of the real
    // pane width; the host sizes it to ~50% of the terminal, not the core
    // sidebar's 42 cols.
    const measuredRightPaneWidth = right.width
    console.log(
      `MEASURED right-pane width = ${measuredRightPaneWidth} (sidebar width = ${SIDEBAR_WIDTH}, delta = ${measuredRightPaneWidth - SIDEBAR_WIDTH})`,
    )
    const frame = app.captureCharFrame()
    const ruler = Array.from({ length: WIDTH }, (_, i) => (i % 10 === 0 ? String((i / 10) % 10) : " ")).join("")
    console.log("---- frame (ruler marks tens) ----")
    console.log(ruler)
    console.log(frame.split("\n").slice(0, 12).join("\n"))

    // (0) the MEASURED width equals the width the harness assigned to the
    // right-pane box, and both the focusable `session-panel` and the plugin's
    // `subagent-panel` fill exactly that box. This proves the printed number is
    // read from the renderer's layout tree, not hardcoded to 42.
    const sessionPanel = root.findDescendantById("session-panel")!
    expect(measuredRightPaneWidth).toBe(PANEL_WIDTH)
    expect(panel.width).toBe(measuredRightPaneWidth)
    expect(sessionPanel.width).toBe(measuredRightPaneWidth)

    // (a) the tree text appears in the RIGHT PANE region.
    expect(panel).toBeDefined()
    expect(frame).toContain("Subagent tree")
    expect(frame).toContain("SUBAGENTS (3)")
    expect(frame).toContain("explore")
    expect(frame).toContain("general")
    expect(frame).toContain("plan")
    expect(columnOf(frame, "Subagent tree")).toBeGreaterThanOrEqual(right.x)
    expect(columnOf(frame, "SUBAGENTS (3)")).toBeGreaterThanOrEqual(right.x)
    expect(columnOf(frame, "explore")).toBeGreaterThanOrEqual(right.x)
    expect(columnOf(frame, "general")).toBeGreaterThanOrEqual(right.x)

    // (b) it does NOT cover the main panel: the main panel is still visible and
    // is geometrically to the LEFT of the right pane, which is not overlapped.
    expect(frame).toContain("MAIN PANEL CONTENT")
    expect(columnOf(frame, "MAIN PANEL CONTENT")).toBeGreaterThanOrEqual(0)
    expect(columnOf(frame, "MAIN PANEL CONTENT")).toBeLessThan(right.x)
    expect(overlaps(transcript, right)).toBe(false)
    expect(transcript.x + transcript.width).toBeLessThanOrEqual(right.x)
    expect(overlaps(bottom, right)).toBe(false)
    expect(pane.x).toBe(0)
    expect(pane.width).toBe(WIDTH - PANEL_WIDTH)

    // (c) the panel geometry sits inside the right-pane box.
    expect(panel.x).toBeGreaterThanOrEqual(right.x)
    expect(panel.x + panel.width).toBeLessThanOrEqual(right.x + right.width)
    expect(panel.y).toBeGreaterThanOrEqual(right.y)
    expect(panel.y + panel.height).toBeLessThanOrEqual(right.y + right.height)
  } finally {
    app.renderer.destroy()
  }
})

/**
 * Focus-trap guard: the host forces a panel fullscreen when
 * `terminalWidth <= 80` (`canSplit = () => width() > 80`), where
 * `pane.focus.left` is disabled and the prompt cannot be refocused. These tests
 * drive the exported guard directly (no rendering needed) and assert it never
 * opens the panel on a narrow/unknown terminal, opens on a wide one, and never
 * throws when the renderer width read fails.
 */
test("openPanelGuarded: does NOT open the panel at terminalWidth <= 80", () => {
  const opened: string[] = []
  const make = (terminalWidth: number) =>
    ({
      renderer: { terminalWidth },
      ui: {
        panel: {
          open: (name: string) => {
            opened.push(name)
            return true
          },
        },
      },
    }) as unknown as Context

  openPanelGuarded(make(80), "ses_narrow_80", "ses_root", "test")
  expect(opened).toEqual([])
  openPanelGuarded(make(0), "ses_narrow_0", "ses_root", "test")
  expect(opened).toEqual([])
  openPanelGuarded(make(-5), "ses_narrow_neg", "ses_root", "test")
  expect(opened).toEqual([])
})

test("openPanelGuarded: opens the panel at terminalWidth > 80", () => {
  const opened: string[] = []
  const context = {
    renderer: { terminalWidth: 120 },
    ui: {
      panel: {
        open: (name: string) => {
          opened.push(name)
          return true
        },
      },
    },
  } as unknown as Context

  openPanelGuarded(context, "ses_wide_120", "ses_root", "test")
  expect(opened).toEqual(["subagent-tree"])
})

test("openPanelGuarded: a renderer width read failure is swallowed, not thrown", () => {
  const context = {
    get renderer(): never {
      throw new Error("renderer unavailable")
    },
    ui: { panel: { open: () => true } },
  } as unknown as Context

  expect(() => openPanelGuarded(context, "ses_err", "ses_root", "test")).not.toThrow()
})
