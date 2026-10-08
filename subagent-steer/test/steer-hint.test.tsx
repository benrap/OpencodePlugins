/**
 * OpenTUI render test for the subagent-steer hint slot contribution.
 *
 * Mounts the real `SteerHint` component from `../tui.tsx` with a minimal mock
 * `Context` and asserts:
 *   - viewing a CHILD session renders the steer hint;
 *   - viewing a ROOT session renders nothing.
 *
 * Runner: `test/run-hint-test.mjs` (needs `OPENTUI_NODE_MODULES`).
 */
/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SteerHint } from "../tui"

type MockSession = { id: string; parentID?: string }

function makeContext(sessions: Map<string, MockSession>): Context {
  return {
    theme: { text: { muted: "#888888", base: "#dddddd" } },
    data: { session: { get: (id: string) => sessions.get(id) } },
    keymap: { shortcuts: () => ["ctrl+shift+s"] },
  } as unknown as Context
}

const WIDTH = 80
const HEIGHT = 6

async function renderHint(sessionID: string, session: MockSession) {
  const sessions = new Map([[session.id, session]])
  const context = makeContext(sessions)
  const app = await testRender(
    () => (
      <box width={WIDTH} height={HEIGHT} flexDirection="column">
        <SteerHint context={context} sessionID={sessionID} />
      </box>
    ),
    { width: WIDTH, height: HEIGHT },
  )
  await app.flush()
  return app
}

test("SteerHint: child session renders the steer hint", async () => {
  const app = await renderHint("ses_child", { id: "ses_child", parentID: "ses_root" })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Steer this subagent")
    expect(frame).toContain("ctrl+shift+s")
  } finally {
    app.renderer.destroy()
  }
})

test("SteerHint: root session renders nothing", async () => {
  const app = await renderHint("ses_root", { id: "ses_root" })
  try {
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Steer this subagent")
  } finally {
    app.renderer.destroy()
  }
})
