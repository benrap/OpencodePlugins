import assert from "node:assert/strict";

// Resolve sibling plugin sources relative to this test file so the suite runs
// against whichever checkout it lives in (repo, git worktree, or a copied live
// config dir) instead of a hard-coded absolute path.
const INDEX = new URL("../index.js", import.meta.url).href;
const REGISTRY = new URL("../subagent-registry.js", import.meta.url).href;

const index = await import(INDEX);
const registryModule = await import(REGISTRY);

const { makeTool, default: plugin, TOOL_NAME } = index;
const {
  createRegistry,
  noteEvent,
  sessionState,
  resolveName,
  isActiveSubagent,
  activeSubagentSessions,
  subscribeRegistry,
} = registryModule;

const results = [];
function check(name, fn) {
  fn();
  results.push(`PASS ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(`PASS ${name}`);
}

// --------------------------------------------------------- tool registration
check('setup registers "subagent-status" with mode "all" and an optional sessionID', () => {
  let captured;
  const ctx = {
    tool: {
      transform: (callback) => {
        callback({ add: (definition) => (captured = definition) });
        return Promise.resolve({ dispose() {} });
      },
    },
  };
  plugin.setup(ctx);
  assert.ok(captured, "editor.add must be called");
  assert.equal(captured.name, TOOL_NAME);
  assert.ok(
    captured.input.properties.mode.enum.includes("all"),
    "mode enum must include 'all'",
  );
  const required = captured.input.required;
  assert.ok(
    !Array.isArray(required) || !required.includes("sessionID"),
    "sessionID must not be a required input",
  );
  assert.equal(captured.input.additionalProperties, false);
});

// ------------------------------------------------------------------ mode all
function activeFixture() {
  const registry = createRegistry();
  const events = [
    { type: "session.created", data: { sessionID: "root", title: "Root session", time: { updated: 1000 } } },
    {
      type: "session.created",
      data: {
        sessionID: "c1",
        parentID: "root",
        title: "Running child",
        agent: "explore",
        time: { updated: 2000 },
      },
    },
    { type: "session.execution.started", data: { sessionID: "c1", time: { updated: 2000 } } },
    {
      type: "session.created",
      data: { sessionID: "c2", parentID: "root", title: "Waiting child", time: { updated: 3000 } },
    },
    {
      type: "session.status",
      data: { sessionID: "c2", status: { type: "waiting" }, time: { updated: 3100 } },
    },
    {
      type: "session.created",
      data: { sessionID: "c3", parentID: "root", title: "Done child", time: { updated: 4000 } },
    },
    { type: "session.execution.started", data: { sessionID: "c3", time: { updated: 4000 } } },
    { type: "session.execution.succeeded", data: { sessionID: "c3", time: { updated: 4100 } } },
  ];
  for (const event of events) noteEvent(registry, event);
  return registry;
}

await checkAsync('mode "all" returns exactly the active subagents, with names and states', async () => {
  const tool = makeTool({}, activeFixture());
  const result = await tool.execute({ mode: "all" }, {});

  assert.equal(result.output.count, result.output.subagents.length);
  assert.equal(result.output.count, 2, "only the running + waiting children are active");

  const byName = new Map(result.output.subagents.map((s) => [s.name, s]));
  assert.deepEqual([...byName.keys()].sort(), ["Running child", "Waiting child"]);

  assert.equal(byName.get("Running child").state, "running");
  assert.equal(byName.get("Running child").sessionID, "c1");
  assert.equal(byName.get("Waiting child").state, "waiting");
  assert.equal(byName.get("Waiting child").sessionID, "c2");

  assert.ok(
    !result.output.subagents.some((s) => s.sessionID === "root"),
    "the root session (no parentID) is excluded",
  );
  assert.ok(
    !result.output.subagents.some((s) => s.name === "Done child"),
    "the succeeded (terminal) child is excluded",
  );
  assert.match(result.content, /2 active subagent\(s\)/);
});

await checkAsync('mode "all" on an empty registry returns the empty shape', async () => {
  const tool = makeTool({}, createRegistry());
  const result = await tool.execute({ mode: "all" }, {});
  assert.deepEqual(result.output, { subagents: [], count: 0 });
  assert.equal(result.content, "No active subagents.");
});

// ------------------------------------------------------ missing / bad input
await checkAsync("missing/unknown input never throws and preserves the state path", async () => {
  const tool = makeTool({}, createRegistry());

  const missing = await tool.execute({}, {});
  assert.equal(missing.output.error, "missing-sessionID");
  assert.equal(missing.output.sessionID, "");

  const noArg = await tool.execute(undefined, {});
  assert.equal(noArg.output.error, "missing-sessionID");

  const bogus = await tool.execute({ mode: "bogus" }, {});
  assert.equal(bogus.output.error, "missing-sessionID", "unknown mode behaves as 'state'");

  // "all" needs no sessionID.
  const allNoSession = await tool.execute({ mode: "all" });
  assert.deepEqual(allNoSession.output, { subagents: [], count: 0 });
});

// ------------------------------------------------------------- existing modes
await checkAsync("state mode is unchanged (outcome succeeded -> finished)", async () => {
  const ctx = { session: { get: async () => ({ outcome: "succeeded" }) } };
  const tool = makeTool(ctx, createRegistry());
  const result = await tool.execute({ sessionID: "ses_x", mode: "state" });
  assert.deepEqual(result.output, { sessionID: "ses_x", state: "finished" });
  assert.equal(result.content, "finished");
});

await checkAsync("summary mode still routes to generation (empty messages path)", async () => {
  const ctx = { session: { get: async () => ({}) } };
  const tool = makeTool(ctx, createRegistry());
  const result = await tool.execute({ sessionID: "ses_x", mode: "summary" });
  assert.equal(result.output.state, "idle");
  assert.match(result.output.summary, /No messages were found for session ses_x/);
  assert.equal(result.content, result.output.summary);
});

// ------------------------------------------------------------ pure registry
check("garbage events and unsafe subscriptions never throw", () => {
  const registry = createRegistry();
  for (const event of [undefined, null, 42, {}, { type: 7 }]) {
    assert.doesNotThrow(() => noteEvent(registry, event));
  }
  assert.equal(registry.sessions.size, 0);
  assert.doesNotThrow(() => subscribeRegistry(undefined, createRegistry()));
  assert.doesNotThrow(() => subscribeRegistry({}, createRegistry()));
});

check("sessionState / resolveName / isActiveSubagent are total and defensive", () => {
  assert.equal(sessionState(undefined), "idle");
  assert.equal(sessionState({}), "idle");
  assert.equal(sessionState({ waiting: true }), "waiting");
  assert.equal(sessionState({ active: true }), "running");
  assert.equal(sessionState({ outcome: "succeeded" }), "done");
  assert.equal(sessionState({ outcome: "failed" }), "failed");
  assert.equal(sessionState({ outcome: "interrupted" }), "stopped");

  assert.equal(resolveName({ name: "  Named  ", agent: "a", id: "x" }), "Named");
  assert.equal(resolveName({ name: "", agent: " agent ", id: "x" }), "agent");
  assert.equal(resolveName({ id: " fallback " }), "fallback");
  assert.equal(resolveName(undefined), "");

  assert.equal(isActiveSubagent(undefined), false);
  assert.equal(isActiveSubagent({ id: "root", active: true }), false, "roots are excluded");
  assert.equal(isActiveSubagent({ id: "c", parentID: "root", active: true }), true);
  assert.equal(isActiveSubagent({ id: "c", parentID: "root", waiting: true }), true);
  assert.equal(isActiveSubagent({ id: "c", parentID: "root", outcome: "succeeded" }), false);
});

check("activeSubagentSessions is sorted by time.updated DESC", () => {
  const registry = createRegistry();
  const entries = [
    ["old", 1000],
    ["newest", 3000],
    ["middle", 2000],
  ];
  for (const [id, updated] of entries) {
    noteEvent(registry, {
      type: "session.created",
      data: { sessionID: id, parentID: "root", title: id, time: { updated } },
    });
    noteEvent(registry, {
      type: "session.execution.started",
      data: { sessionID: id, time: { updated } },
    });
  }
  const ids = activeSubagentSessions(registry).map((record) => record.id);
  assert.deepEqual(ids, ["newest", "middle", "old"]);
});

console.log(results.join("\n"));
console.log(`\n${results.length} checks passed`);
