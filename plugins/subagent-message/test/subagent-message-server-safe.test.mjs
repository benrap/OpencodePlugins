import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// Importing these modules must succeed with NO @opentui/*, solid-js, or
// tui.tsx present in the resolution graph. If any of them touched a TUI
// dependency, this import would throw ERR_MODULE_NOT_FOUND. Resolve relative to
// this test file so it runs against whichever checkout it lives in.
const serverURL = new URL("../server.ts", import.meta.url)
const messageURL = new URL("../subagent-message.ts", import.meta.url)
const lineageURL = new URL("../lineage.ts", import.meta.url)

const server = await import(serverURL.href)
const message = await import(messageURL.href)
const lineage = await import(lineageURL.href)

// Default export shape.
const plugin = server.default
assert.equal(typeof plugin, "object", "server default export must be an object")
assert.equal(plugin.id, "subagent-message", "server plugin id must match")
assert.equal(typeof plugin.setup, "function", "server plugin must expose setup()")

// setup() must be a harmless no-op.
const cleanup = plugin.setup()
assert.equal(cleanup, undefined, "no-op setup returns nothing")

// No TUI / framework dependencies may appear as an import in any server-side
// source. (Plain-text mentions inside comments are fine; only real import
// specifiers are matched.)
const FORBIDDEN_IMPORTS = [
  /(?:from|import)\s*\(?\s*["']@opentui\//,
  /(?:from|import)\s*\(?\s*["']solid-js["'/]/,
  /(?:from|import)\s*\(?\s*["']@opencode\/plugin/,
]
for (const [name, url] of [
  ["server.ts", serverURL],
  ["subagent-message.ts", messageURL],
  ["lineage.ts", lineageURL],
]) {
  const source = readFileSync(url, "utf8")
  for (const pattern of FORBIDDEN_IMPORTS) {
    assert.ok(!pattern.test(source), `${name} must not import ${pattern}`)
  }
}

// The public surface the server entrypoint relies on must exist.
assert.equal(typeof message.installMessageTool, "function")
assert.equal(typeof message.makeMessageTool, "function")
assert.equal(message.MESSAGE_TOOL_NAME, "message_agent")
assert.equal(typeof lineage.relationOf, "function")
assert.equal(typeof lineage.assertMessageable, "function")
assert.equal(typeof lineage.deliveryFor, "function")
assert.equal(typeof lineage.frameMessage, "function")

console.log("PASS server.ts imported and evaluated without @opentui/* or solid-js")
console.log(`PASS default export shape: { id: "${plugin.id}", setup: function }`)
console.log("PASS setup() is a no-op and did not throw")
console.log("PASS server.ts, subagent-message.ts, lineage.ts contain no TUI/core framework imports")
console.log("PASS message_agent tool + lineage helper exports are present")
