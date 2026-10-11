/**
 * Portable unit tests for `subagent-abort-tui`.
 *
 * Run with plain Node (no OpenTUI / solid-js required):
 *
 *   node --experimental-strip-types test/subagent-abort-tui.test.mjs
 */
import assert from "node:assert/strict"
import {
  COMMAND_ID,
  SLASH_NAME,
  abortSubtree,
  abortToast,
  childIDs,
  collectSubtreeIDs,
  interruptInput,
  interruptOrder,
  resolveViewedChild,
} from "../abort.ts"

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

// ---------------------------------------------------------------------------
// childIDs (flat-map of a session.list response to ids)
// ---------------------------------------------------------------------------

await check("childIDs: flattens a `{ data: [{ id }] }` response to ids", () => {
  assert.deepEqual(childIDs({ data: [{ id: "a" }, { id: "b" }] }), ["a", "b"])
})

await check("childIDs: trims ids and drops malformed entries", () => {
  assert.deepEqual(
    childIDs({ data: [{ id: "  a  " }, {}, { id: null }, { id: 7 }, "x", null] }),
    ["a"],
  )
})

await check("childIDs: tolerates missing/undefined/junk responses", () => {
  assert.deepEqual(childIDs(undefined), [])
  assert.deepEqual(childIDs(null), [])
  assert.deepEqual(childIDs({}), [])
  assert.deepEqual(childIDs({ data: "nope" }), [])
  assert.deepEqual(childIDs(42), [])
})

// ---------------------------------------------------------------------------
// interruptInput (the interrupt call construction)
// ---------------------------------------------------------------------------

await check("interruptInput: is { sessionID, resume: false, cancelBackground: true }", () => {
  assert.deepEqual(interruptInput("ses_1"), {
    sessionID: "ses_1",
    resume: false,
    cancelBackground: true,
  })
})

// ---------------------------------------------------------------------------
// collectSubtreeIDs
// ---------------------------------------------------------------------------

/** A mock `session.list` over a `{ parentID: [childID, ...] }` adjacency map. */
function listFrom(tree, options = {}) {
  return async ({ parentID }) => {
    if (options.throwOn === parentID) throw new Error("list failed")
    return { data: (tree[parentID] ?? []).map((id) => ({ id })) }
  }
}

const TREE = {
  child: ["grandchild1", "grandchild2"],
  grandchild1: ["great-grandchild"],
  grandchild2: [],
  "great-grandchild": [],
}

await check("collectSubtreeIDs: includes the root and every descendant", async () => {
  const ids = await collectSubtreeIDs("child", listFrom(TREE))
  assert.deepEqual(
    [...ids].sort(),
    ["child", "grandchild1", "grandchild2", "great-grandchild"].sort(),
  )
  assert.equal(ids.length, 4)
})

await check("collectSubtreeIDs: returns the root first, then breadth-first", async () => {
  const ids = await collectSubtreeIDs("child", listFrom(TREE))
  assert.equal(ids[0], "child")
  assert.ok(ids.indexOf("grandchild1") < ids.indexOf("great-grandchild"))
  assert.ok(ids.indexOf("grandchild2") < ids.indexOf("great-grandchild"))
})

await check("collectSubtreeIDs: a cycle does not loop forever and does not duplicate ids", async () => {
  // child -> x, y ; x -> y, child ; y -> x  (every edge forms a cycle)
  const cyclic = { child: ["x", "y"], x: ["y", "child"], y: ["x"] }
  const ids = await collectSubtreeIDs("child", listFrom(cyclic))
  assert.deepEqual([...ids].sort(), ["child", "x", "y"])
  assert.equal(new Set(ids).size, ids.length, "ids must be unique")
})

await check("collectSubtreeIDs: a second path to the same child does not duplicate it", async () => {
  const shared = { child: ["a", "b"], a: ["shared"], b: ["shared"], shared: [] }
  const ids = await collectSubtreeIDs("child", listFrom(shared))
  assert.deepEqual([...ids].sort(), ["a", "b", "child", "shared"])
})

await check("collectSubtreeIDs: caps expansion depth (malformed deep chain terminates)", async () => {
  const deep = { root: ["n0"] }
  for (let i = 0; i < 40; i += 1) deep[`n${i}`] = [`n${i + 1}`]
  const ids = await collectSubtreeIDs("root", listFrom(deep), { maxDepth: 16 })
  // root + 16 expanded levels (n0..n15); n16 is never reached.
  assert.equal(ids.length, 17)
  assert.ok(ids.includes("n15"))
  assert.equal(ids.includes("n16"), false)
})

await check("collectSubtreeIDs: a throwing list call yields the root only, never throws", async () => {
  const ids = await collectSubtreeIDs("child", listFrom(TREE, { throwOn: "child" }))
  assert.deepEqual(ids, ["child"])
})

await check("collectSubtreeIDs: an empty/invalid root returns no ids", async () => {
  assert.deepEqual(await collectSubtreeIDs("", listFrom(TREE)), [])
  assert.deepEqual(await collectSubtreeIDs("   ", listFrom(TREE)), [])
  assert.deepEqual(await collectSubtreeIDs(undefined, listFrom(TREE)), [])
})

// ---------------------------------------------------------------------------
// interruptOrder (descendants before the viewed session)
// ---------------------------------------------------------------------------

await check("interruptOrder: reverses breadth-first into children-before-parents", () => {
  const rootFirst = ["child", "grandchild1", "grandchild2", "great-grandchild"]
  const ordered = interruptOrder(rootFirst)
  assert.equal(ordered[ordered.length - 1], "child", "the viewed session aborts last")
  assert.ok(ordered.indexOf("great-grandchild") < ordered.indexOf("grandchild1"))
  // it never mutates its input
  assert.deepEqual(rootFirst, ["child", "grandchild1", "grandchild2", "great-grandchild"])
})

// ---------------------------------------------------------------------------
// abortSubtree (mock client: enumeration + interrupt call shape)
// ---------------------------------------------------------------------------

/**
 * A MOCK plugin client. `list` serves the adjacency `tree`; `interrupt`
 * records every argument and (optionally) fails for ids in `failOn`.
 */
function mockClient(tree, options = {}) {
  const interruptCalls = []
  return {
    interruptCalls,
    client: {
      session: {
        list: async ({ parentID }) => ({ data: (tree[parentID] ?? []).map((id) => ({ id })) }),
        interrupt: async (input) => {
          interruptCalls.push(input)
          if (options.failOn && options.failOn.includes(input.sessionID)) {
            throw new Error("interrupt failed")
          }
          return { interrupted: true }
        },
      },
    },
  }
}

await check("abortSubtree: interrupts exactly the viewed session + descendants", async () => {
  const mock = mockClient(TREE)
  const result = await abortSubtree(mock.client, "child")
  const called = mock.interruptCalls.map((call) => call.sessionID)
  assert.deepEqual(
    [...called].sort(),
    ["child", "grandchild1", "grandchild2", "great-grandchild"].sort(),
  )
  assert.equal(called.length, 4)
  assert.deepEqual([...result.targets].sort(), [...called].sort())
  assert.deepEqual([...result.aborted].sort(), [...called].sort())
  assert.deepEqual(result.failed, [])
})

await check("abortSubtree: every interrupt call carries the cancelBackground flag", async () => {
  const mock = mockClient(TREE)
  await abortSubtree(mock.client, "child")
  for (const call of mock.interruptCalls) {
    assert.equal(typeof call.sessionID, "string")
    assert.deepEqual(call, {
      sessionID: call.sessionID,
      resume: false,
      cancelBackground: true,
    })
  }
})

await check("abortSubtree: aborts the viewed session last (descendants first)", async () => {
  const mock = mockClient(TREE)
  await abortSubtree(mock.client, "child")
  const called = mock.interruptCalls.map((call) => call.sessionID)
  assert.equal(called[called.length - 1], "child")
  assert.ok(called.indexOf("great-grandchild") < called.indexOf("grandchild1"))
})

await check("abortSubtree: a cycle terminates and never duplicates an interrupt", async () => {
  const cyclic = { child: ["x", "y"], x: ["y", "child"], y: ["x"] }
  const mock = mockClient(cyclic)
  const result = await abortSubtree(mock.client, "child")
  const called = mock.interruptCalls.map((call) => call.sessionID)
  assert.deepEqual([...called].sort(), ["child", "x", "y"])
  assert.equal(new Set(called).size, called.length)
  assert.equal(result.failed.length, 0)
})

await check("abortSubtree: a failing interrupt is recorded, the rest still abort", async () => {
  const mock = mockClient(TREE, { failOn: ["grandchild1"] })
  const result = await abortSubtree(mock.client, "child")
  assert.deepEqual(result.failed, ["grandchild1"])
  assert.deepEqual([...result.aborted].sort(), ["child", "grandchild2", "great-grandchild"])
})

await check("abortSubtree: an undeterminable root is a no-op", async () => {
  const mock = mockClient(TREE)
  const result = await abortSubtree(mock.client, "")
  assert.deepEqual(mock.interruptCalls, [])
  assert.deepEqual(result, { aborted: [], failed: [], targets: [] })
})

// ---------------------------------------------------------------------------
// abortToast (one toast, with the count)
// ---------------------------------------------------------------------------

await check("abortToast: success reports the aborted count", () => {
  assert.deepEqual(abortToast({ aborted: ["a", "b", "c"], failed: [], targets: [] }), {
    message: "Aborted 3 subagents",
    variant: "success",
  })
})

await check("abortToast: singular count reads `subagent`", () => {
  assert.equal(abortToast({ aborted: ["a"], failed: [], targets: [] }).message, "Aborted 1 subagent")
})

await check("abortToast: any failure is an error toast", () => {
  const partial = abortToast({ aborted: ["a"], failed: ["b"], targets: [] })
  assert.equal(partial.variant, "error")
  assert.equal(partial.message, "Aborted 1 of 2 subagents")

  const all = abortToast({ aborted: [], failed: ["b", "c"], targets: [] })
  assert.equal(all.variant, "error")
  assert.equal(all.message, "Failed to abort 2 subagents")
})

console.log(results.join("\n"))
console.log(`\n${results.length} checks passed`)
