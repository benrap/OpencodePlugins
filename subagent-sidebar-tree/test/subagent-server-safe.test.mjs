import assert from "node:assert/strict"

// Importing this module must succeed with NO @opentui/*, solid-js, or tui.tsx
// present in the resolution graph. If server.ts (or its transitive imports)
// touched any of those, this import would throw ERR_MODULE_NOT_FOUND.
const mod = await import(
  "file:///%USERPROFILE%/.config/opencode/plugins/subagent-sidebar-tree/server.ts"
)
const plugin = mod.default

assert.equal(typeof plugin, "object", "server default export must be an object")
assert.equal(plugin.id, "subagent-sidebar-tree", "server plugin id must match")
assert.equal(typeof plugin.setup, "function", "server plugin must expose setup()")

// setup() must be a harmless no-op.
const cleanup = plugin.setup()
assert.equal(cleanup, undefined, "no-op setup returns nothing")

console.log("PASS server.ts imported and evaluated without @opentui/solid")
console.log(`PASS default export shape: { id: "${plugin.id}", setup: function }`)
console.log("PASS setup() is a no-op and did not throw")
