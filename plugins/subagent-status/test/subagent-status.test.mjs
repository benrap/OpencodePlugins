import assert from "node:assert/strict";
import {
  descendantSessions,
  isActiveSubagent as isActiveSidebarSubagent,
} from "../../subagent-sidebar-tree/subagent-view.ts";

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
  const result = await tool.execute({ mode: "all" }, { sessionID: "root" });

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
  const result = await tool.execute({ mode: "all" }, { sessionID: "root" });
  assert.deepEqual(result.output, { subagents: [], count: 0 });
  assert.equal(result.content, "No active subagents.");
});

function scopedFixture() {
  const registry = createRegistry();
  const ids = {
    rootA: "ses_A",
    a1: "ses_A1",
    a2: "ses_A2",
    a1x: "ses_A1X",
    aDone: "ses_ADone",
    aIdle: "ses_AIdle",
    rootB: "ses_B",
    b1: "ses_B1",
    b1x: "ses_B1X",
    bDone: "ses_BDone",
    rootC: "ses_C",
    c1: "ses_C1",
    rootD: "ses_D",
    dDone: "ses_DDone",
  };
  const created = (sessionID, parentID, title, updated) => ({
    type: "session.created",
    data: { sessionID, parentID, title, time: { updated } },
  });
  const started = (sessionID, updated) => ({
    type: "session.execution.started",
    data: { sessionID, time: { updated } },
  });
  const succeeded = (sessionID, updated) => ({
    type: "session.execution.succeeded",
    data: { sessionID, time: { updated } },
  });
  const status = (sessionID, kind, updated) => ({
    type: "session.status",
    data: { sessionID, status: { type: kind }, time: { updated } },
  });

  const events = [
    created(ids.rootA, undefined, "Root A", 100),
    created(ids.a1, ids.rootA, "A1 running", 200),
    // Duplicate create must not duplicate the descendant in `all`.
    created(ids.a1, ids.rootA, "A1 running (duplicate event)", 250),
    started(ids.a1, 260),
    created(ids.a2, ids.rootA, "A2 waiting", 300),
    status(ids.a2, "waiting", 310),
    created(ids.a1x, ids.a1, "A1X nested running", 320),
    started(ids.a1x, 330),
    created(ids.aDone, ids.rootA, "A done", 400),
    started(ids.aDone, 400),
    succeeded(ids.aDone, 410),
    created(ids.aIdle, ids.rootA, "A idle", 500),
    status(ids.aIdle, "idle", 510),
    created(ids.rootB, undefined, "Root B", 120),
    created(ids.b1, ids.rootB, "B1 running", 210),
    started(ids.b1, 215),
    created(ids.b1x, ids.b1, "B1X nested running", 220),
    started(ids.b1x, 225),
    created(ids.bDone, ids.rootB, "B done", 300),
    started(ids.bDone, 300),
    succeeded(ids.bDone, 310),
    created(ids.rootC, undefined, "Root C", 130),
    created(ids.c1, ids.rootC, "C1 running", 220),
    started(ids.c1, 225),
    created(ids.rootD, undefined, "Root D", 140),
    created(ids.dDone, ids.rootD, "D done", 300),
    started(ids.dDone, 300),
    succeeded(ids.dDone, 310),
  ];
  for (const event of events) noteEvent(registry, event);
  return { registry, ids };
}

await checkAsync('mode "all" is scoped to the caller\'s active descendant subtree', async () => {
  const { registry, ids } = scopedFixture();
  const tool = makeTool({}, registry);
  const result = await tool.execute({ mode: "all" }, { sessionID: ids.rootA });
  const byID = new Map(result.output.subagents.map((subagent) => [subagent.sessionID, subagent]));

  assert.equal(result.output.count, 3, "only A's running/waiting descendants are active");
  assert.equal(result.output.subagents.length, 3, "duplicate events must not duplicate rows");
  assert.deepEqual(
    result.output.subagents.map((subagent) => subagent.sessionID),
    [ids.a1x, ids.a2, ids.a1],
    "same time.updated DESC ordering as the global inventory",
  );
  assert.deepEqual([...byID.keys()].sort(), [ids.a1, ids.a1x, ids.a2].sort());

  assert.equal(byID.get(ids.a1).state, "running");
  assert.equal(byID.get(ids.a2).state, "waiting");
  assert.equal(byID.get(ids.a1x).state, "running");

  for (const forbidden of [
    ids.aDone,
    ids.aIdle,
    ids.rootA,
    ids.b1,
    ids.b1x,
    ids.bDone,
    ids.rootB,
    ids.c1,
    ids.rootC,
    ids.rootD,
    ids.dDone,
  ]) {
    assert.ok(!byID.has(forbidden), `${forbidden} must not appear in A's list`);
  }

  // Parity with the sidebar tree's authoritative descendant + active semantics.
  const activityOf = (sessionID) => {
    const record = registry.sessions.get(sessionID);
    if (record && record.waiting) return "waiting";
    if (record && record.active) return "running";
    return "idle";
  };
  const expected = descendantSessions([...registry.sessions.values()], ids.rootA)
    .filter((session) => isActiveSidebarSubagent(session, activityOf(session.id)))
    .map((session) => session.id);

  assert.deepEqual([...byID.keys()].sort(), [...expected].sort());
  assert.equal(result.output.count, expected.length);
  assert.match(result.content, /3 active subagent\(s\)/);
});

await checkAsync('mode "all" from a nested caller returns only its own active descendants', async () => {
  const { registry, ids } = scopedFixture();
  const tool = makeTool({}, registry);
  const result = await tool.execute({ mode: "all" }, { sessionID: ids.a1 });

  assert.deepEqual(
    result.output.subagents.map((subagent) => subagent.sessionID),
    [ids.a1x],
  );
  assert.equal(result.output.count, 1);
  assert.equal(result.output.subagents[0].state, "running");

  const returned = new Set(result.output.subagents.map((subagent) => subagent.sessionID));
  for (const foreign of [ids.a1, ids.a2, ids.b1, ids.b1x, ids.rootB, ids.c1]) {
    assert.ok(!returned.has(foreign), `${foreign} is outside the nested caller's subtree`);
  }
});

await checkAsync('mode "all" returns empty without active descendants or a caller id', async () => {
  const { registry, ids } = scopedFixture();
  const tool = makeTool({}, registry);

  const noDescendants = await tool.execute({ mode: "all" }, { sessionID: ids.rootD });
  assert.deepEqual(noDescendants.output, { subagents: [], count: 0 });
  assert.equal(noDescendants.content, "No active subagents.");

  // Other roots still have active descendants, so the empty result proves there
  // is no process-wide fallback.
  const sibling = await tool.execute({ mode: "all" }, { sessionID: ids.rootB });
  assert.equal(sibling.output.count, 2);

  const noCaller = await tool.execute({ mode: "all" });
  assert.deepEqual(noCaller.output, { subagents: [], count: 0 });
  assert.equal(noCaller.content, "No active subagents.");
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

  // "all" needs no input sessionID, but without a caller context it must not
  // fall back to the process-wide registry.
  const allNoSession = await tool.execute({ mode: "all" });
  assert.deepEqual(allNoSession.output, { subagents: [], count: 0 });
  assert.equal(allNoSession.content, "No active subagents.");
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
