/**
 * Portable unit tests for `subagent-steer`.
 *
 * Run with plain Node (no OpenTUI / solid-js required):
 *
 *   node --experimental-strip-types test/subagent-steer.test.mjs
 */
import assert from "node:assert/strict"
import { resolveSteerTarget, steerSession } from "../steer.ts"

const results = []

async function check(name, fn) {
  await fn()
  results.push(`PASS ${name}`)
}

// ---------------------------------------------------------------------------
// resolveSteerTarget
// ---------------------------------------------------------------------------

await check("resolveSteerTarget: viewing a child returns the child id", () => {
  const target = resolveSteerTarget({ type: "session", sessionID: "ses_child" }, (id) => ({
    parentID: "ses_root",
    id,
  }))
  assert.equal(target, "ses_child")
})

await check("resolveSteerTarget: viewing a root/main session returns null", () => {
  assert.equal(
    resolveSteerTarget({ type: "session", sessionID: "ses_root" }, () => ({ parentID: undefined })),
    null,
  )
  assert.equal(
    resolveSteerTarget({ type: "session", sessionID: "ses_root" }, () => ({ parentID: null })),
    null,
  )
  assert.equal(
    resolveSteerTarget({ type: "session", sessionID: "ses_missing" }, () => undefined),
    null,
  )
})

await check("resolveSteerTarget: non-session routes return null", () => {
  const child = () => ({ parentID: "ses_root" })
  assert.equal(resolveSteerTarget({ type: "home" }, child), null)
  assert.equal(resolveSteerTarget({ type: "plugin", id: "p", name: "n" }, child), null)
  assert.equal(resolveSteerTarget(undefined, child), null)
  assert.equal(resolveSteerTarget(null, child), null)
})

// ---------------------------------------------------------------------------
// steerSession
// ---------------------------------------------------------------------------

await check("steerSession: builds the exact call on a fake client", async () => {
  const calls = []
  const client = {
    session: {
      prompt: (input) => {
        calls.push(input)
        return Promise.resolve("admitted")
      },
    },
  }

  const promise = steerSession(client, "ses_child", "hello")
  assert.notEqual(promise, null, "non-empty text must return a promise")
  const result = await promise
  assert.equal(result, "admitted")
  assert.deepEqual(calls, [{ sessionID: "ses_child", text: "hello" }])
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "parts"), false, "no parts key")
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "delivery"), false, "no delivery key")
})

await check("steerSession: trims text before sending", async () => {
  const calls = []
  const client = { session: { prompt: (input) => (calls.push(input), Promise.resolve()) } }
  await steerSession(client, "ses_child", "  spaced  ")
  assert.deepEqual(calls, [{ sessionID: "ses_child", text: "spaced" }])
})

await check("steerSession: empty/whitespace text returns null and does NOT call the client", () => {
  const calls = []
  const client = { session: { prompt: (input) => (calls.push(input), Promise.resolve()) } }

  assert.equal(steerSession(client, "ses_child", ""), null)
  assert.equal(steerSession(client, "ses_child", "   "), null)
  assert.equal(steerSession(client, "ses_child", "\n\t  \r"), null)
  assert.equal(steerSession(client, "ses_child", undefined), null)
  assert.equal(calls.length, 0, "client must not be called for empty input")
})

await check("steerSession: does not send a delivery field (backend defaults to steer)", async () => {
  const calls = []
  const client = { session: { prompt: (input) => (calls.push(input), Promise.resolve()) } }
  await steerSession(client, "ses_child", "no delivery")
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "delivery"), false)
})

console.log(results.join("\n"))
console.log(`\n${results.length} checks passed`)
