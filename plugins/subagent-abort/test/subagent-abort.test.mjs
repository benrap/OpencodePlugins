import assert from "node:assert/strict"

// Resolve sibling plugin sources relative to this test file so the suite runs
// against whichever checkout it lives in (repo, git worktree, or a copied live
// config dir) instead of a hard-coded absolute path.
const VIEW = new URL("../subagent-view.ts", import.meta.url).href
const ABORT = new URL("../subagent-abort.ts", import.meta.url).href

const { abortTargets, assertAbortable, isDescendantOf, isRootSession, descendantSessions } = await import(VIEW)
const {
  ABORT_TOOL_NAME,
  createRegistry,
  noteEvent,
  executeAbort,
  installAbortTool,
  makeAbortTool,
} = await import(ABORT)

const s = (id, parentID, outcome, updated = 0, agent) => ({
  id,
  parentID,
  outcome,
  agent,
  time: { updated },
})
const byId = (list) => new Map(list.map((x) => [x.id, x]))
const activityFrom = (set) => (session) => (set.has(session.id) ? "running" : "idle")

const results = []
function check(name, fn) {
  fn()
  results.push(`PASS ${name}`)
}
async function checkAsync(name, fn) {
  await fn()
  results.push(`PASS ${name}`)
}

// ------------------------------------------------------------- isRootSession
check("isRootSession: no parent is a root, a parent is not, undefined is root", () => {
  assert.equal(isRootSession({ id: "r" }), true)
  assert.equal(isRootSession({ id: "c", parentID: "r" }), false)
  assert.equal(isRootSession(undefined), true)
})

// ----------------------------------------------------------- isDescendantOf
const lineage = byId([
  s("root", undefined, undefined, 100),
  s("caller", "root", undefined, 90),
  s("a", "caller", undefined, 80),
  s("a1", "a", undefined, 70),
  s("sib", "root", undefined, 60),
])

check("isDescendantOf: direct descendant is true", () => {
  assert.equal(isDescendantOf("a", "caller", lineage), true)
})

check("isDescendantOf: deep descendant is true", () => {
  assert.equal(isDescendantOf("a1", "caller", lineage), true)
})

check("isDescendantOf: sibling of the caller's child is false", () => {
  assert.equal(isDescendantOf("sib", "caller", lineage), false)
})

check("isDescendantOf: a session is never its own descendant", () => {
  assert.equal(isDescendantOf("caller", "caller", lineage), false)
})

check("isDescendantOf: reversed relationship is false", () => {
  assert.equal(isDescendantOf("caller", "a", lineage), false)
})

check("isDescendantOf: unknown ancestor is false", () => {
  assert.equal(isDescendantOf("a", "nope", lineage), false)
})

const cycle = byId([s("x", "y"), s("y", "x")])
check("isDescendantOf: cycle-safe and self-safe", () => {
  assert.equal(isDescendantOf("x", "z", cycle), false)
  assert.equal(isDescendantOf("x", "x", cycle), false)
  // y really is x's parent, even inside the cycle
  assert.equal(isDescendantOf("x", "y", cycle), true)
})

const broken = byId([s("orphan", "ghost")])
check("isDescendantOf: missing parent breaks the chain", () => {
  assert.equal(isDescendantOf("orphan", "caller", broken), false)
})

// ----------------------------------------------------------- assertAbortable
check("assertAbortable: rejects a root target", () => {
  assert.deepEqual(assertAbortable("caller", s("root"), lineage), { ok: false, reason: "root" })
})

check("assertAbortable: rejects a self target", () => {
  assert.deepEqual(assertAbortable("caller", lineage.get("caller"), lineage), {
    ok: false,
    reason: "self",
  })
})

check("assertAbortable: rejects a sibling / non-descendant target", () => {
  assert.deepEqual(assertAbortable("caller", lineage.get("sib"), lineage), {
    ok: false,
    reason: "not-descendant",
  })
})

check("assertAbortable: accepts a direct descendant", () => {
  assert.deepEqual(assertAbortable("caller", lineage.get("a"), lineage), { ok: true })
})

check("assertAbortable: accepts a deep descendant", () => {
  assert.deepEqual(assertAbortable("caller", lineage.get("a1"), lineage), { ok: true })
})

check("assertAbortable: rejects a terminal target", () => {
  const terminal = s("a", "caller", "succeeded")
  assert.deepEqual(assertAbortable("caller", terminal, lineage), {
    ok: false,
    reason: "terminal",
  })
})

check("assertAbortable: rejects a missing target", () => {
  assert.deepEqual(assertAbortable("caller", undefined, lineage), {
    ok: false,
    reason: "not-found",
  })
})

// --------------------------------------------------------------- abortTargets
const tree = [
  s("root", undefined, undefined, 100),
  s("caller", "root", undefined, 90),
  s("a", "caller", undefined, 80),
  s("a1", "a", undefined, 70),
  s("b", "caller", undefined, 60),
  s("done", "caller", "succeeded", 50),
  s("grandDone", "done", undefined, 40),
  s("sib", "root", undefined, 30),
]
const running = new Set(["a", "a1", "b"])

check("abortTargets(all): selects exactly the running descendants", () => {
  const ids = abortTargets("caller", tree, {
    all: true,
    activityOf: activityFrom(running),
  }).map((x) => x.id)
  assert.deepEqual(ids, ["a", "a1", "b"])
})

check("abortTargets(all): excludes the focused session and any root", () => {
  const ids = abortTargets("caller", tree, {
    all: true,
    activityOf: activityFrom(new Set(["root", "caller", "a", "sib"])),
  }).map((x) => x.id)
  assert.deepEqual(ids, ["a"])
})

check("abortTargets(all): terminal descendants are skipped by default activity", () => {
  const ids = abortTargets("caller", tree, { all: true }).map((x) => x.id)
  assert.ok(!ids.includes("done"), "a succeeded session must not be a target")
  assert.ok(ids.includes("a") && ids.includes("a1") && ids.includes("b"))
})

check("abortTargets(explicit): filters to the named running descendant", () => {
  const ids = abortTargets("caller", tree, {
    sessionID: "a1",
    activityOf: activityFrom(running),
  }).map((x) => x.id)
  assert.deepEqual(ids, ["a1"])
})

check("abortTargets(explicit): skips a non-running/terminal explicit id", () => {
  assert.deepEqual(
    abortTargets("caller", tree, { sessionID: "done", activityOf: activityFrom(running) }),
    [],
  )
})

check("abortTargets: no all and no explicit id yields no targets", () => {
  assert.deepEqual(abortTargets("caller", tree, { activityOf: activityFrom(running) }), [])
})

check("abortTargets(explicit): a sibling id is never a target", () => {
  assert.deepEqual(
    abortTargets("caller", tree, { sessionID: "sib", activityOf: activityFrom(running) }),
    [],
  )
})

// --------------------------------------------------------------- registry
check("noteEvent: session.created/execution events track lineage and activity", () => {
  const registry = createRegistry()
  noteEvent(registry, { type: "session.created", data: { sessionID: "p", time: { updated: 1 } } })
  noteEvent(registry, {
    type: "session.created",
    data: { sessionID: "c", parentID: "p", agent: "explore", time: { updated: 2 } },
  })
  noteEvent(registry, { type: "session.execution.started", data: { sessionID: "c" } })
  assert.equal(registry.sessions.get("c").parentID, "p")
  assert.equal(registry.sessions.get("c").agent, "explore")
  assert.equal(registry.active.has("c"), true)

  noteEvent(registry, { type: "session.execution.succeeded", data: { sessionID: "c" } })
  assert.equal(registry.active.has("c"), false)
  assert.equal(registry.sessions.get("c").outcome, "succeeded")

  noteEvent(registry, { type: "session.deleted", data: { sessionID: "c" } })
  assert.equal(registry.sessions.has("c"), false)
})

check("noteEvent: malformed events are ignored", () => {
  const registry = createRegistry()
  for (const e of [undefined, null, 42, {}, { type: 7 }, { type: "x" }]) {
    assert.doesNotThrow(() => noteEvent(registry, e))
  }
  assert.equal(registry.sessions.size, 0)
})

// ------------------------------------------------------- install / tool shape
check("installAbortTool registers one tool via ctx.tool.transform", () => {
  let added
  const ctx = {
    tool: {
      transform: (callback) => {
        callback({ add: (definition) => (added = definition) })
        return Promise.resolve({ dispose() {} })
      },
    },
  }
  installAbortTool(ctx)
  assert.ok(added, "editor.add must be called")
  assert.equal(added.name, ABORT_TOOL_NAME)
  assert.equal(typeof added.description, "string")
  assert.equal(added.input.type, "object")
  assert.deepEqual(Object.keys(added.input.properties), ["sessionID", "all"])
  assert.equal(typeof added.execute, "function")
})

check("installAbortTool(undefined) is a harmless no-op", () => {
  assert.doesNotThrow(() => installAbortTool(undefined))
  assert.doesNotThrow(() => installAbortTool({ tool: {} }))
})

check("makeAbortTool produces the confirmed tool definition shape", () => {
  const definition = makeAbortTool(undefined, createRegistry())
  assert.equal(definition.name, "abort_subagent")
  assert.equal(definition.options.codemode, false)
  assert.equal(definition.input.additionalProperties, false)
})

// ------------------------------------------------------- executeAbort (mock)
function fixture({ interrupt, permission } = {}) {
  const registry = createRegistry()
  const events = [
    { type: "session.created", data: { sessionID: "root", time: { updated: 100 } } },
    {
      type: "session.created",
      data: { sessionID: "caller", parentID: "root", agent: "build", time: { updated: 90 } },
    },
    {
      type: "session.created",
      data: { sessionID: "a", parentID: "caller", agent: "explore", time: { updated: 80 } },
    },
    { type: "session.created", data: { sessionID: "a1", parentID: "a", time: { updated: 70 } } },
    { type: "session.created", data: { sessionID: "b", parentID: "caller", agent: "plan", time: { updated: 60 } } },
    { type: "session.execution.started", data: { sessionID: "a" } },
    { type: "session.execution.started", data: { sessionID: "a1" } },
  ]
  for (const event of events) noteEvent(registry, event)

  const calls = []
  const ctx = {
    session: {
      get: async ({ sessionID }) => {
        const record = registry.sessions.get(sessionID)
        if (!record) return undefined
        return {
          id: record.id,
          parentID: record.parentID,
          agent: record.agent,
          title: record.title,
          outcome: record.outcome,
          time: { updated: record.time.updated },
        }
      },
      interrupt:
        interrupt ??
        (async (arg) => {
          calls.push(arg)
          return { interrupted: true }
        }),
    },
    ...(permission ? { permission } : {}),
  }
  return { registry, ctx, calls }
}

await checkAsync("executeAbort(all:true) aborts exactly the running descendants", async () => {
  const { registry, ctx, calls } = fixture()
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { all: true }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(new Set(result.aborted), new Set(["a", "a1"]))
  assert.deepEqual(result.failures, [])
  assert.equal(calls.length, 2)
  assert.ok(calls.every((arg) => arg.resume === false))
  assert.ok(!result.aborted.includes("caller"))
  assert.ok(!result.aborted.includes("root"))
})

await checkAsync("executeAbort(sessionID) aborts a single named descendant", async () => {
  const { registry, ctx } = fixture()
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "a" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, ["a"])
})

await checkAsync("executeAbort: the root session is never aborted", async () => {
  const { registry, ctx } = fixture()
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "root" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, [])
})

await checkAsync("executeAbort: self is never aborted", async () => {
  const { registry, ctx } = fixture()
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "caller" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, [])
})

await checkAsync("executeAbort: a sibling (non-descendant) is never aborted", async () => {
  const { registry, ctx } = fixture()
  noteEvent(registry, {
    type: "session.created",
    data: { sessionID: "sib", parentID: "root", time: { updated: 50 } },
  })
  noteEvent(registry, { type: "session.execution.started", data: { sessionID: "sib" } })
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "sib" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, [])
})

await checkAsync("executeAbort: a terminal descendant is skipped", async () => {
  const { registry, ctx } = fixture()
  noteEvent(registry, { type: "session.execution.started", data: { sessionID: "b" } })
  noteEvent(registry, {
    type: "session.execution.succeeded",
    data: { sessionID: "b", time: { updated: 61 } },
  })
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "b" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, [])
})

await checkAsync("executeAbort: an interrupt failure is reported, not thrown", async () => {
  const { registry } = fixture()
  const ctx = {
    session: {
      get: async ({ sessionID }) => {
        const record = registry.sessions.get(sessionID)
        return record
          ? { id: record.id, parentID: record.parentID, agent: record.agent, time: { updated: record.time.updated } }
          : undefined
      },
      interrupt: async () => {
        throw new Error("boom")
      },
    },
  }
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "a" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, [])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].sessionID, "a")
  assert.equal(result.failures[0].reason, "interrupt-failed")
})

await checkAsync("executeAbort: the permission gate is honored when exposed", async () => {
  const calls = []
  const { registry, ctx } = fixture({
    interrupt: async () => ({ interrupted: true }),
    permission: {
      assert: async (input) => {
        calls.push(input)
        throw new Error("denied")
      },
    },
  })
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "a" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, [])
  assert.equal(result.failures[0].reason, "permission-denied")
  assert.equal(calls[0].action, "subagent")
  assert.deepEqual(calls[0].resources, ["explore"])
})

await checkAsync("executeAbort: an unknown caller is reported, not thrown", async () => {
  const { registry, ctx } = fixture()
  const result = JSON.parse((await executeAbort(ctx, registry, { all: true }, {})).content)
  assert.deepEqual(result.aborted, [])
  assert.equal(typeof result.error, "string")
})

await checkAsync("executeAbort: a restarted (previously done) descendant is abortable again", async () => {
  const { registry, ctx } = fixture()
  // "a" ran, succeeded, then was restarted/continued: started must clear the
  // stale outcome, otherwise the terminal guard blocks a real abort.
  noteEvent(registry, { type: "session.execution.succeeded", data: { sessionID: "a" } })
  assert.equal(registry.sessions.get("a").outcome, "succeeded")
  noteEvent(registry, { type: "session.execution.started", data: { sessionID: "a" } })
  assert.equal(registry.sessions.get("a").outcome, undefined)
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "a" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, ["a"])
})

await checkAsync("executeAbort: a server idle no-op is reported, not counted as aborted", async () => {
  const { registry, ctx } = fixture({ interrupt: async () => ({ interrupted: false }) })
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "a" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, [])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].reason, "not-running")
})

await checkAsync("executeAbort: an interrupt response carrying an error is a failure", async () => {
  const { registry, ctx } = fixture({ interrupt: async () => ({ error: "nope" }) })
  const result = JSON.parse(
    (await executeAbort(ctx, registry, { sessionID: "a" }, { sessionID: "caller" })).content,
  )
  assert.deepEqual(result.aborted, [])
  assert.equal(result.failures[0].reason, "interrupt-failed")
})

check("descendantSessions: a cyclic/self-parent lineage terminates without throwing", () => {
  // A self-parent edge: "b"'s parent is "a", and a duplicate "a" record declares
  // itself as its own parent. Use a list (not byId) so both records survive.
  const list = [
    s("caller", "root"),
    s("a", "caller"),
    s("a", "a"), // self-parent
    s("b", "a"),
  ]
  assert.doesNotThrow(() => descendantSessions(list, "caller"))
  const ids = descendantSessions(list, "caller").map((x) => x.id)
  assert.ok(ids.includes("a"), "a must be reached")
  assert.ok(ids.includes("b"), "b must be reached")
  assert.equal(new Set(ids).size, ids.length, "no duplicates")
})

console.log(results.join("\n"))
console.log(`\n${results.length} checks passed`)
