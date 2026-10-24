import assert from "node:assert/strict"

// Resolve sibling plugin sources relative to this test file so the suite runs
// against whichever checkout it lives in (repo, git worktree, or a copied live
// config dir) instead of a hard-coded absolute path.
const LINEAGE = new URL("../lineage.ts", import.meta.url).href
const MESSAGE = new URL("../subagent-message.ts", import.meta.url).href

const { relationOf, assertMessageable, deliveryFor, frameMessage } = await import(LINEAGE)
const {
  MESSAGE_TOOL_NAME,
  MAX_MESSAGE_LENGTH,
  createRegistry,
  noteEvent,
  sessionActivity,
  executeMessage,
  installMessageTool,
  makeMessageTool,
} = await import(MESSAGE)

const s = (id, parentID, opts = {}) => ({
  id,
  parentID,
  outcome: opts.outcome,
  agent: opts.agent,
  title: opts.title,
  time: { updated: opts.updated ?? 0 },
})
const byId = (list) => new Map(list.map((x) => [x.id, x]))

const results = []
function check(name, fn) {
  fn()
  results.push(`PASS ${name}`)
}
async function checkAsync(name, fn) {
  await fn()
  results.push(`PASS ${name}`)
}

// ---------------------------------------------------------------- relationOf
const lineage = byId([
  s("root", undefined),
  s("caller", "root"),
  s("child", "caller"),
  s("grandchild", "child"),
  s("sib", "root"),
])

check("relationOf: direct child is 'child'", () => {
  assert.equal(relationOf("caller", lineage.get("child"), lineage), "child")
})

check("relationOf: direct parent is 'parent'", () => {
  assert.equal(relationOf("child", lineage.get("caller"), lineage), "parent")
})

check("relationOf: direct child -> root parent is 'parent' (root is a valid edge)", () => {
  assert.equal(relationOf("caller", lineage.get("root"), lineage), "parent")
})

check("relationOf: siblings, grandchildren, grandchild->root, unrelated are null", () => {
  assert.equal(relationOf("caller", lineage.get("sib"), lineage), null)
  assert.equal(relationOf("caller", lineage.get("grandchild"), lineage), null)
  assert.equal(relationOf("grandchild", lineage.get("root"), lineage), null)
  assert.equal(relationOf("caller", s("stranger", "someone"), lineage), null)
  assert.equal(relationOf("caller", s("orphan", undefined), lineage), null)
})

check("relationOf: total on missing/blank input", () => {
  assert.equal(relationOf("caller", undefined, lineage), null)
  assert.equal(relationOf("caller", null, lineage), null)
  assert.equal(relationOf("", lineage.get("child"), lineage), null)
  assert.equal(relationOf("   ", lineage.get("child"), lineage), null)
  assert.equal(relationOf("caller", s("", undefined), lineage), null)
  // A direct child is recognizable from `target.parentID` alone, with no lookup.
  assert.equal(relationOf("caller", lineage.get("child"), undefined), "child")
  assert.equal(relationOf("caller", lineage.get("child"), {}), "child")
  assert.equal(relationOf("caller", undefined, undefined), null)
})

// ----------------------------------------------------------- assertMessageable
check("assertMessageable: accepts a direct child with relation 'child'", () => {
  assert.deepEqual(assertMessageable("caller", lineage.get("child"), lineage), {
    ok: true,
    relation: "child",
  })
})

check("assertMessageable: accepts a direct parent (including root) as 'parent'", () => {
  assert.deepEqual(assertMessageable("child", lineage.get("caller"), lineage), {
    ok: true,
    relation: "parent",
  })
  assert.deepEqual(assertMessageable("caller", lineage.get("root"), lineage), {
    ok: true,
    relation: "parent",
  })
})

check("assertMessageable: rejects self, unknown, and everything not-adjacent", () => {
  assert.deepEqual(assertMessageable("caller", lineage.get("caller"), lineage), {
    ok: false,
    reason: "self",
  })
  assert.deepEqual(assertMessageable("caller", undefined, lineage), {
    ok: false,
    reason: "not-found",
  })
  assert.deepEqual(assertMessageable("caller", s("", undefined), lineage), {
    ok: false,
    reason: "not-found",
  })
  assert.deepEqual(assertMessageable("caller", lineage.get("sib"), lineage), {
    ok: false,
    reason: "not-adjacent",
  })
  assert.deepEqual(assertMessageable("caller", lineage.get("grandchild"), lineage), {
    ok: false,
    reason: "not-adjacent",
  })
  assert.deepEqual(assertMessageable("grandchild", lineage.get("root"), lineage), {
    ok: false,
    reason: "not-adjacent",
  })
})

// --------------------------------------------------------------- deliveryFor
check("deliveryFor: running/waiting steer, idle queues", () => {
  assert.equal(deliveryFor("running"), "steer")
  assert.equal(deliveryFor("waiting"), "steer")
  assert.equal(deliveryFor("idle"), "queue")
})

// -------------------------------------------------------------- frameMessage
check("frameMessage: wraps with a child/parent provenance envelope", () => {
  assert.equal(
    frameMessage("ses_1", "child", "hello"),
    "[message from your child session ses_1]\n\nhello",
  )
  assert.equal(
    frameMessage("ses_2", "parent", "ping"),
    "[message from your parent session ses_2]\n\nping",
  )
})

// --------------------------------------------------------------- registry
check("registry: events track lineage + running/waiting/idle activity", () => {
  const registry = createRegistry()
  noteEvent(registry, {
    type: "session.created",
    data: { sessionID: "x", parentID: "p", agent: "build", time: { updated: 1 } },
  })
  assert.equal(registry.sessions.get("x").parentID, "p")
  assert.equal(registry.sessions.get("x").agent, "build")
  assert.equal(sessionActivity(registry, "x"), "idle")

  noteEvent(registry, { type: "session.execution.started", data: { sessionID: "x" } })
  assert.equal(sessionActivity(registry, "x"), "running")

  noteEvent(registry, {
    type: "session.status",
    data: { sessionID: "x", status: { type: "waiting" } },
  })
  assert.equal(sessionActivity(registry, "x"), "waiting")

  noteEvent(registry, {
    type: "session.status",
    data: { sessionID: "x", status: { type: "idle" } },
  })
  assert.equal(sessionActivity(registry, "x"), "idle")

  noteEvent(registry, { type: "session.execution.succeeded", data: { sessionID: "x" } })
  assert.equal(sessionActivity(registry, "x"), "idle")
  assert.equal(sessionActivity(registry, "unknown"), "idle")
})

// ------------------------------------------------------- install / tool shape
check("(i) installMessageTool(undefined) and ({tool:{}}) are harmless no-ops", () => {
  assert.doesNotThrow(() => installMessageTool(undefined))
  assert.doesNotThrow(() => installMessageTool({ tool: {} }))
})

check("(i) installMessageTool registers exactly one message_agent tool", () => {
  const added = []
  const ctx = {
    tool: {
      transform: (callback) => {
        callback({ add: (definition) => added.push(definition) })
        return Promise.resolve({ dispose() {} })
      },
    },
  }
  installMessageTool(ctx)
  assert.equal(added.length, 1)
  assert.equal(added[0].name, MESSAGE_TOOL_NAME)
  assert.equal(added[0].options.codemode, false)
  assert.equal(added[0].input.type, "object")
  assert.equal(added[0].input.additionalProperties, false)
  assert.deepEqual(Object.keys(added[0].input.properties), ["sessionID", "message"])
  assert.deepEqual(added[0].input.required, ["sessionID", "message"])
  assert.equal(typeof added[0].execute, "function")
})

check("makeMessageTool produces the confirmed tool definition shape", () => {
  const definition = makeMessageTool(undefined, createRegistry())
  assert.equal(definition.name, "message_agent")
  assert.equal(definition.options.codemode, false)
  assert.equal(definition.input.additionalProperties, false)
})

check("(j) noteEvent is total on malformed events", () => {
  const registry = createRegistry()
  const malformed = [
    undefined,
    null,
    42,
    "x",
    {},
    { type: 7 },
    { type: "x" },
    { type: "session.created" },
    { type: "session.created", data: 5 },
    { type: "session.created", data: { sessionID: 9 } },
  ]
  for (const event of malformed) assert.doesNotThrow(() => noteEvent(registry, event))
  assert.equal(registry.sessions.size, 0)
  assert.doesNotThrow(() =>
    noteEvent(null, { type: "session.created", data: { sessionID: "z" } }),
  )
})

// ------------------------------------------------------- executeMessage (mock)
function fixture({ prompt } = {}) {
  const registry = createRegistry()
  const calls = []
  const promptFn =
    prompt ??
    (async (arg) => {
      calls.push(arg)
      return { ok: true }
    })
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
      prompt: promptFn,
    },
  }
  return { registry, ctx, calls }
}

function seed(registry) {
  const events = [
    { type: "session.created", data: { sessionID: "root", time: { updated: 100 } } },
    {
      type: "session.created",
      data: { sessionID: "p", parentID: "root", agent: "build", time: { updated: 90 } },
    },
    {
      type: "session.created",
      data: { sessionID: "c", parentID: "p", agent: "explore", time: { updated: 80 } },
    },
    { type: "session.created", data: { sessionID: "g", parentID: "c", time: { updated: 70 } } },
    { type: "session.created", data: { sessionID: "sib", parentID: "root", time: { updated: 60 } } },
    {
      type: "session.created",
      data: { sessionID: "stranger", parentID: "someone", time: { updated: 50 } },
    },
    { type: "session.created", data: { sessionID: "orphan", time: { updated: 40 } } },
  ]
  for (const event of events) noteEvent(registry, event)
  return registry
}

// (a) parent -> direct child
await checkAsync(
  "(a) parent -> direct child: allowed as 'child' and STEERS a running child",
  async () => {
    const { registry, ctx, calls } = fixture()
    seed(registry)
    noteEvent(registry, { type: "session.execution.started", data: { sessionID: "c" } })
    const result = JSON.parse(
      (await executeMessage(ctx, registry, { sessionID: "c", message: "hello child" }, { sessionID: "p" }))
        .content,
    )
    assert.deepEqual(result.failures, [])
    assert.equal(result.delivered.length, 1)
    assert.deepEqual(result.delivered[0], {
      sessionID: "c",
      relation: "child",
      delivery: "steer",
      activity: "running",
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].delivery, "steer")
  },
)

await checkAsync("(a) parent -> direct child: QUEUES an idle child", async () => {
  const { registry, ctx, calls } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "c", message: "hi" }, { sessionID: "p" })).content,
  )
  assert.equal(result.delivered[0].delivery, "queue")
  assert.equal(result.delivered[0].activity, "idle")
  assert.equal(calls[0].delivery, "queue")
})

// (b) child -> parent
await checkAsync("(b) child -> parent: allowed as 'parent'", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "p", message: "hi parent" }, { sessionID: "c" }))
      .content,
  )
  assert.deepEqual(result.failures, [])
  assert.equal(result.delivered[0].relation, "parent")
})

await checkAsync("(b) child -> ROOT parent: allowed as 'parent' (direct edge)", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "root", message: "hi root" }, { sessionID: "p" }))
      .content,
  )
  assert.equal(result.delivered[0].relation, "parent")
})

// (c) rejected as not-adjacent
await checkAsync("(c) sibling is rejected as not-adjacent", async () => {
  const { registry, ctx, calls } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "sib", message: "hi sib" }, { sessionID: "p" }))
      .content,
  )
  assert.deepEqual(result.delivered, [])
  assert.deepEqual(result.failures, [{ sessionID: "sib", reason: "not-adjacent" }])
  assert.equal(calls.length, 0)
})

await checkAsync("(c) grandchild is rejected as not-adjacent", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "g", message: "hi grandchild" }, { sessionID: "p" }))
      .content,
  )
  assert.deepEqual(result.failures, [{ sessionID: "g", reason: "not-adjacent" }])
})

await checkAsync("(c) grandchild -> root (skips the parent) is rejected as not-adjacent", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "root", message: "hi root" }, { sessionID: "g" }))
      .content,
  )
  assert.deepEqual(result.failures, [{ sessionID: "root", reason: "not-adjacent" }])
})

await checkAsync("(c) unrelated and no-relationship sessions are rejected as not-adjacent", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const unrelated = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "stranger", message: "hi" }, { sessionID: "p" }))
      .content,
  )
  assert.deepEqual(unrelated.failures, [{ sessionID: "stranger", reason: "not-adjacent" }])
  const orphan = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "orphan", message: "hi" }, { sessionID: "p" }))
      .content,
  )
  assert.deepEqual(orphan.failures, [{ sessionID: "orphan", reason: "not-adjacent" }])
})

// (d) other rejections
await checkAsync("(d) self is rejected", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "p", message: "hi me" }, { sessionID: "p" })).content,
  )
  assert.deepEqual(result.failures, [{ sessionID: "p", reason: "self" }])
})

await checkAsync("(d) unknown target is not-found", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "nope", message: "hi" }, { sessionID: "p" })).content,
  )
  assert.deepEqual(result.failures, [{ sessionID: "nope", reason: "not-found" }])
})

await checkAsync("(d) missing caller returns an error, never throws", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "c", message: "hi" }, {})).content,
  )
  assert.deepEqual(result.delivered, [])
  assert.equal(typeof result.error, "string")
})

await checkAsync("(d) missing sessionID and empty message are rejected", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const missing = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "   ", message: "hi" }, { sessionID: "p" }))
      .content,
  )
  assert.deepEqual(missing.failures, [{ sessionID: "", reason: "missing-sessionID" }])
  const empty = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "c", message: "   " }, { sessionID: "p" }))
      .content,
  )
  assert.deepEqual(empty.failures, [{ sessionID: "c", reason: "empty-message" }])
})

await checkAsync("(d) over-length message is rejected with the max length", async () => {
  const { registry, ctx, calls } = fixture()
  seed(registry)
  const result = JSON.parse(
    (
      await executeMessage(
        ctx,
        registry,
        { sessionID: "c", message: "x".repeat(MAX_MESSAGE_LENGTH + 1) },
        { sessionID: "p" },
      )
    ).content,
  )
  assert.deepEqual(result.failures, [
    { sessionID: "c", reason: "message-too-long", maxLength: MAX_MESSAGE_LENGTH },
  ])
  assert.equal(calls.length, 0)
})

// (e) caller identity cannot be spoofed
await checkAsync(
  "(e) caller identity comes from toolContext.sessionID and cannot be spoofed by input",
  async () => {
    const { registry, ctx, calls } = fixture()
    seed(registry)
    // Hostile input claims to be the sibling. Judged against the REAL caller (p),
    // the sibling is still not-adjacent and nothing is delivered.
    const result = JSON.parse(
      (
        await executeMessage(
          ctx,
          registry,
          { sessionID: "sib", message: "hi", caller: "sib", from: "p", sessionId: "sib" },
          { sessionID: "p" },
        )
      ).content,
    )
    assert.deepEqual(result.delivered, [])
    assert.deepEqual(result.failures, [{ sessionID: "sib", reason: "not-adjacent" }])
    assert.equal(calls.length, 0)
  },
)

// (f) delivery fallback
await checkAsync("(f) a failed first prompt retries without `delivery` and still succeeds", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  const prompts = []
  ctx.session.prompt = async (arg) => {
    prompts.push(arg)
    if (prompts.length === 1) throw new Error("unknown field: delivery")
    return { ok: true }
  }
  const result = JSON.parse(
    (await executeMessage(ctx, registry, { sessionID: "c", message: "hi" }, { sessionID: "p" })).content,
  )
  assert.deepEqual(result.failures, [])
  assert.equal(result.delivered.length, 1)
  assert.equal(prompts.length, 2)
  assert.equal("delivery" in prompts[0], true)
  assert.equal("delivery" in prompts[1], false)
  assert.equal(prompts[1].text, prompts[0].text)
})

// (g) delivery failure is reported
await checkAsync("(g) an always-failing prompt is reported as delivery-failed, not thrown", async () => {
  const { registry, ctx } = fixture()
  seed(registry)
  ctx.session.prompt = async () => {
    throw new Error("boom")
  }
  const outcome = await executeMessage(
    ctx,
    registry,
    { sessionID: "c", message: "hi" },
    { sessionID: "p" },
  )
  const result = JSON.parse(outcome.content)
  assert.deepEqual(result.delivered, [])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].sessionID, "c")
  assert.equal(result.failures[0].reason, "delivery-failed")
  assert.equal(result.failures[0].message, "boom")
})

// (h) provenance envelope
await checkAsync("(h) the framed provenance envelope is passed to session.prompt", async () => {
  const { registry, ctx, calls } = fixture()
  seed(registry)
  await executeMessage(ctx, registry, { sessionID: "c", message: "payload here" }, { sessionID: "p" })
  assert.match(calls[0].text, /^\[message from your child session p\]/)
  assert.ok(calls[0].text.includes("payload here"))

  calls.length = 0
  await executeMessage(ctx, registry, { sessionID: "p", message: "up here" }, { sessionID: "c" })
  assert.match(calls[0].text, /^\[message from your parent session c\]/)
  assert.ok(calls[0].text.includes("up here"))
})

// (turn-safety) executeMessage never throws for a bad prompt context
await checkAsync("executeMessage tolerates a context with no session.prompt", async () => {
  const registry = createRegistry()
  seed(registry)
  const outcome = await executeMessage({}, registry, { sessionID: "c", message: "hi" }, { sessionID: "p" })
  const result = JSON.parse(outcome.content)
  assert.deepEqual(result.delivered, [])
  assert.equal(result.failures[0].reason, "delivery-failed")
})

console.log(results.join("\n"))
console.log(`\n${results.length} checks passed`)
