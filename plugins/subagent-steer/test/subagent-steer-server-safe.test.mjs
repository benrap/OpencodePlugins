import assert from "node:assert/strict"

// Importing this module must succeed with NO @opentui/*, solid-js, or tui.tsx
// present in the resolution graph. If server.ts (or its transitive imports)
// touched any of those, this import would throw ERR_MODULE_NOT_FOUND.
// Resolve relative to this test file so it runs against the local checkout.
const mod = await import(new URL("../server.ts", import.meta.url).href)
const plugin = mod.default

assert.equal(typeof plugin, "object", "server default export must be an object")
assert.equal(plugin.id, "subagent-steer", "server plugin id must match")
assert.equal(typeof plugin.setup, "function", "server plugin must expose setup()")

// steer.ts is the shared logic module and must also be dependency-free.
const steer = await import(new URL("../steer.ts", import.meta.url).href)
assert.equal(typeof steer.resolveSteerTarget, "function")
assert.equal(typeof steer.steerSession, "function")

// setup() must be a harmless no-op.
const cleanup = plugin.setup()
assert.equal(cleanup, undefined, "no-op setup returns nothing")

console.log("PASS server.ts + steer.ts imported without @opentui/solid")
console.log(`PASS default export shape: { id: "${plugin.id}", setup: function }`)
console.log("PASS setup() is a no-op and did not throw")
