/**
 * Portable unit tests for `subagent-abort-tui`.
 *
 * Run with plain Node (no OpenTUI / solid-js required):
 *
 *   node --experimental-strip-types test/subagent-abort-tui.test.mjs
 */
import assert from "node:assert/strict"
import { COMMAND_ID, SLASH_NAME, resolveViewedChild } from "../abort.ts"

const results = []

async function check(name, fn) {
  await fn()
  results.push(`PASS ${name}`)
}

// ---------------------------------------------------------------------------
// resolveViewedChild
// ---------------------------------------------------------------------------

await check("resolveViewedChild: viewing a child returns the child id", () => {
  const target = resolveViewedChild({ type: "session", sessionID: "ses_child" }, (id) => ({
    parentID: "ses_root",
    id,
  }))
  assert.equal(target, "ses_child")
})

await check("resolveViewedChild: viewing a root/main session returns null", () => {
  assert.equal(
    resolveViewedChild({ type: "session", sessionID: "ses_root" }, () => ({ parentID: undefined })),
    null,
  )
  assert.equal(
    resolveViewedChild({ type: "session", sessionID: "ses_root" }, () => ({ parentID: null })),
    null,
  )
})

await check("resolveViewedChild: a missing session returns null", () => {
  assert.equal(
    resolveViewedChild({ type: "session", sessionID: "ses_missing" }, () => undefined),
    null,
  )
})

await check("resolveViewedChild: non-session routes return null", () => {
  const child = () => ({ parentID: "ses_root" })
  assert.equal(resolveViewedChild({ type: "home" }, child), null)
  assert.equal(resolveViewedChild({ type: "plugin", id: "p", name: "n" }, child), null)
  assert.equal(resolveViewedChild(undefined, child), null)
  assert.equal(resolveViewedChild(null, child), null)
})

await check("resolveViewedChild: session route with no sessionID returns null", () => {
  const child = () => ({ parentID: "ses_root" })
  assert.equal(resolveViewedChild({ type: "session" }, child), null)
  assert.equal(resolveViewedChild({ type: "session", sessionID: "" }, child), null)
})

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

await check("SLASH_NAME is the `/abort` command name", () => {
  assert.equal(SLASH_NAME, "abort")
})

await check("COMMAND_ID is the stable keybind/config identifier", () => {
  assert.equal(COMMAND_ID, "subagent.abort")
})

console.log(results.join("\n"))
console.log(`\n${results.length} checks passed`)
