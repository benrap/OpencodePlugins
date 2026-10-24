/**
 * Before/after diagnostic for the subagent sidebar layout.
 *
 * BEFORE reproduces the previous revision: an absolutely-positioned overlay
 * pinned to the right edge from the host's `app` slot, over a session pane that
 * takes the full width. It prints the layout and frame so the main panel being
 * covered is visible.
 *
 * AFTER reproduces the fix: the tree is contributed to the core sidebar's
 * `sidebar.content`, and the host lays the sidebar out as a flex sibling of the
 * session pane, so the main panel is resized to make room.
 *
 *   node test/run-diagnose-overlay.mjs
 */
/** @jsxImportSource @opentui/solid */
import { test } from "bun:test"
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

type MockSession = { id: string; parentID?: string; agent?: string; title?: string; time: { updated: number } }

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
    ui: { router: { current: () => ({ type: "session", sessionID: currentSessionID }), navigate: () => {} } },
  } as unknown as Context
}

function filler(prefix: string): string {
  return (prefix + " ").repeat(40).slice(0, 200)
}

function SessionPane() {
  return (
    <box id="session-pane" flexGrow={1} flexBasis={0} minWidth={0} minHeight={0} height="100%" flexDirection="column">
      <box flexGrow={1} minHeight={0} flexDirection="column" paddingBottom={1} paddingLeft={2} paddingRight={2}>
        <box id="transcript" flexGrow={1} minHeight={0} position="relative" backgroundColor={RGBA.fromInts(10, 10, 60)}>
          <text id="main-panel-marker" fg={RGBA.fromInts(120, 120, 255)} wrapMode="none">
            {filler("MAINPANEL")}
          </text>
          <text fg={RGBA.fromInts(120, 120, 255)} wrapMode="none">
            {filler("MAINPANEL")}
          </text>
        </box>
        <box flexShrink={0}>
          <box id="bottom-panel">
            <text id="bottom-panel-marker" fg={RGBA.fromInts(255, 170, 170)} wrapMode="none">
              {filler("BOTTOMPANEL")}
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

function AppShell(props: { children: any }) {
  return (
    <box width={WIDTH} height={HEIGHT} flexDirection="column" backgroundColor={RGBA.fromInts(16, 16, 16)}>
      <box id="main-row" flexGrow={1} minHeight={0} flexDirection="row" position="relative">
        <box id="A" flexGrow={1} minWidth={0} flexDirection="column">
          <box id="B-route" flexGrow={1} minHeight={0} flexDirection="column">
            <box id="SF" flexGrow={1} minWidth={0} minHeight={0} flexDirection="row" position="relative">
              <SessionPane />
              {props.children}
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}

/** BEFORE: the old absolute overlay from the `app` slot (session pane full width). */
function LegacyOverlayHarness(props: { context: Context; syncState: any }) {
  return (
    <AppShell>
      <box
        id="legacy-overlay"
        backgroundColor={raised}
        width={SIDEBAR_WIDTH}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position="absolute"
        zIndex={100}
        right={0}
        top={0}
        bottom={0}
        flexDirection="column"
      >
        <SubagentSidebar context={props.context} sessionID="ses_child" syncState={props.syncState} />
      </box>
    </AppShell>
  )
}

/** AFTER: the core sidebar as a flex sibling, with the tree in `sidebar.content`. */
function FixedHarness(props: { context: Context; syncState: any }) {
  return (
    <AppShell>
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
            <SubagentSidebar context={props.context} sessionID="ses_child" syncState={props.syncState} />
          </box>
        </scrollbox>
      </box>
    </AppShell>
  )
}

function overlaps(a: any, b: any): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x
}

function report(app: any, label: string) {
  const root = app.renderer.root
  const transcript = root.findDescendantById("transcript")!
  const bottom = root.findDescendantById("bottom-panel")!
  const sidebar = root.findDescendantById("core-sidebar") ?? root.findDescendantById("legacy-overlay")!
  console.log(`\n===== ${label} =====`)
  console.log(`  session-pane width = ${root.findDescendantById("session-pane")!.width}`)
  console.log(`  sidebar            x=${sidebar.x} y=${sidebar.y} w=${sidebar.width} h=${sidebar.height}`)
  console.log(`  transcript         x=${transcript.x} y=${transcript.y} w=${transcript.width} h=${transcript.height}`)
  console.log(`  bottom-panel       x=${bottom.x} y=${bottom.y} w=${bottom.width} h=${bottom.height}`)
  console.log(`  main panel covered by sidebar: ${overlaps(transcript, sidebar)}`)
  console.log(`  bottom panel covered by sidebar: ${overlaps(bottom, sidebar)}`)
  const frame = app.captureCharFrame()
  const ruler = Array.from({ length: WIDTH }, (_, i) => (i % 10 === 0 ? String((i / 10) % 10) : " ")).join("")
  console.log("  ---- frame (ruler marks tens, first 10 lines) ----")
  console.log("  " + ruler)
  console.log(
    frame
      .split("\n")
      .slice(0, 10)
      .map((line) => "  " + line)
      .join("\n"),
  )
}

test("BEFORE vs AFTER", async () => {
  const before = await testRender(
    () => <LegacyOverlayHarness context={mockContext("ses_child")} syncState={{ children: new Set(), messages: new Set() }} />,
    { width: WIDTH, height: HEIGHT },
  )
  await before.renderOnce()
  report(before, "BEFORE: app-slot absolute overlay (main panel covered)")
  before.renderer.destroy()

  const after = await testRender(
    () => <FixedHarness context={mockContext("ses_child")} syncState={{ children: new Set(), messages: new Set() }} />,
    { width: WIDTH, height: HEIGHT },
  )
  await after.renderOnce()
  report(after, "AFTER: core sidebar flex sibling (main panel resized, not covered)")
  after.renderer.destroy()
})
