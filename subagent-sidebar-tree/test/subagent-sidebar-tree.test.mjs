import assert from "node:assert/strict"
import {
  RECENT_WINDOW_MS,
  activeSubagents,
  agentColorIndex,
  descendantSessions,
  isActiveSubagent,
  isVisibleSubagent,
  latestTaskDescription,
  resolveBaseColor,
  resolveMutedColor,
  shorten,
  stableHash,
  subagentStatus,
  subagentTree,
  treeContinuation,
  treePrefix,
  visibleSubagentIDs,
  visibleSubagents,
} from "../subagent-view.ts"

const s = (id, parentID, outcome, updated) => ({
  id,
  parentID,
  outcome,
  time: { updated },
})

const activityMap = (map) => (id) => map[id] ?? "idle"

const results = []
function check(name, fn) {
  fn()
  results.push(`PASS ${name}`)
}

// ---------------------------------------------------------------- (a) legacy
check("(a) running child is kept", () => {
  const child = s("child", "root", undefined, 10)
  const kept = activeSubagents([child], activityMap({ child: "running" }))
  assert.deepEqual(kept.map((x) => x.id), ["child"])
})

check("(b) idle child is dropped", () => {
  const child = s("child", "root", undefined, 10)
  const kept = activeSubagents([child], activityMap({ child: "idle" }))
  assert.deepEqual(kept, [])
})

check("(c) running grandchild is kept via descendantSessions", () => {
  const all = [
    s("child", "root", undefined, 10),
    s("grandchild", "child", undefined, 11),
  ]
  const descendants = descendantSessions(all, "root")
  assert.deepEqual(descendants.map((x) => x.id), ["grandchild", "child"])
  const kept = activeSubagents(descendants, activityMap({ grandchild: "running" }))
  assert.deepEqual(kept.map((x) => x.id), ["grandchild"])
})

check("(d) mixed set yields only running, in time-descending order", () => {
  const all = [
    s("a", "root", undefined, 30),
    s("b", "root", "succeeded", 20),
    s("c", "root", undefined, 10),
    s("d", "root", "failed", 5),
  ]
  const kept = activeSubagents(all, activityMap({ a: "running", c: "running" }))
  assert.deepEqual(kept.map((x) => x.id), ["a", "c"])
})

check("(e) all-idle set yields empty list", () => {
  const all = [
    s("a", "root", "succeeded", 3),
    s("b", "root", "failed", 2),
    s("c", "root", undefined, 1),
  ]
  assert.deepEqual(activeSubagents(all, activityMap({})), [])
})

check("extra: running beats outcome; predicate matches subagentStatus", () => {
  const runningButSucceeded = s("x", "root", "succeeded", 1)
  assert.equal(isActiveSubagent(runningButSucceeded, "running"), true)
  assert.equal(subagentStatus(runningButSucceeded, "running"), "running")
  assert.equal(isActiveSubagent(s("y", "root", "succeeded", 1), "idle"), false)
  assert.equal(subagentStatus(s("y", "root", "succeeded", 1), "idle"), "done")
})

// ---------------------------------------------------------------- (b) tree
const running = (map) => (session) => (map[session.id] ?? "idle") === "running"

check("tree: order/depth/isLast/prefix for parent child grandchild sibling", () => {
  // root
  //  ├ parentA          (updated 40, running)
  //  │   └ childA1      (updated 30, running)
  //  │       └ grandA   (updated 20, running)
  //  └ parentB          (updated 10, running)   <- sibling of parentA
  const all = [
    s("parentA", "root", undefined, 40),
    s("childA1", "parentA", undefined, 30),
    s("grandA", "childA1", undefined, 20),
    s("parentB", "root", undefined, 10),
  ]
  const visible = running({ parentA: "running", childA1: "running", grandA: "running", parentB: "running" })
  const tree = subagentTree(all, "root", visible)

  assert.deepEqual(tree.map((n) => n.session.id), ["parentA", "childA1", "grandA", "parentB"])
  assert.deepEqual(tree.map((n) => n.depth), [0, 1, 2, 0])
  // parentA is not last (parentB follows); childA1 is parentA's only/last child;
  // grandA is childA1's only/last child; parentB is the last root child.
  assert.deepEqual(tree.map((n) => n.isLast), [false, true, true, true])
  assert.deepEqual(tree.map((n) => n.ancestorIsLast), [[], [false], [false, true], []])

  assert.deepEqual(tree.map((n) => n.prefix), ["├─ ", "│  └─ ", "│     └─ ", "└─ "])

  // exact rendered connector lines (prefix + label)
  assert.equal(`${tree[0].prefix}parentA`, "├─ parentA")
  assert.equal(`${tree[1].prefix}childA1`, "│  └─ childA1")
  assert.equal(`${tree[2].prefix}grandA`, "│     └─ grandA")
  assert.equal(`${tree[3].prefix}parentB`, "└─ parentB")
})

check("tree: prefix uses only unicode box-drawing chars and spaces", () => {
  const all = [
    s("a", "root", undefined, 4),
    s("a1", "a", undefined, 3),
    s("a2", "a", undefined, 2),
    s("b", "root", undefined, 1),
  ]
  const visible = running({ a: "running", a1: "running", a2: "running", b: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.prefix), ["├─ ", "│  ├─ ", "│  └─ ", "└─ "])
  for (const node of tree) {
    assert.match(node.prefix, /^[│├└─ ]*$/, `prefix "${node.prefix}" must use only │, ├, └, ─ and spaces`)
  }
})

check("tree: invisible intermediate node is compressed (descendant stays connected)", () => {
  // parent (hidden/idle) -> child (running) should attach under root at depth 0
  const all = [
    s("parent", "root", "succeeded", 30),
    s("child", "parent", undefined, 20),
  ]
  const visible = running({ child: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["child"])
  assert.equal(tree[0].depth, 0)
  assert.equal(tree[0].prefix, "└─ ")
})

check("tree: sibling buckets sorted by time.updated DESC", () => {
  const all = [
    s("old", "root", undefined, 1),
    s("new", "root", undefined, 9),
    s("mid", "root", undefined, 5),
  ]
  const visible = running({ old: "running", new: "running", mid: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["new", "mid", "old"])
})

// ------------------------------- (b2) connectors rebuilt from visible structure
check("tree: two visible roots use ├─ then └─", () => {
  const all = [s("A", "root", undefined, 30), s("B", "root", undefined, 20)]
  const visible = running({ A: "running", B: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["A", "B"])
  assert.deepEqual(tree.map((n) => n.isLast), [false, true])
  assert.deepEqual(tree.map((n) => n.prefix), ["├─ ", "└─ "])
})

// BUG 1: the last VISIBLE sibling must be └─ even when an invisible sibling
// sorts after it (the old code marked the last visible node as non-last).
check("tree (bug 1): trailing invisible root sibling does not demote last visible", () => {
  // Sort order by time: A(30), C(20), B(10). B is invisible and sorts LAST,
  // so C is the last visible root and must render └─, not ├─.
  const all = [
    s("A", "root", undefined, 30),
    s("C", "root", undefined, 20),
    s("B", "root", "succeeded", 10),
  ]
  const visible = running({ A: "running", C: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["A", "C"])
  assert.deepEqual(tree.map((n) => n.isLast), [false, true])
  assert.deepEqual(tree.map((n) => n.prefix), ["├─ ", "└─ "])
})

// BUG 2: a nested visible subtree under a non-last parent carries the ancestor
// │ column, and each level's connectors are computed among visible siblings.
check("tree (bug 2): nested visible children keep ancestor │", () => {
  const all = [
    s("A", "root", undefined, 40),
    s("A1", "A", undefined, 30),
    s("A2", "A", undefined, 20),
    s("B", "root", undefined, 10),
  ]
  const visible = running({ A: "running", A1: "running", A2: "running", B: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["A", "A1", "A2", "B"])
  assert.deepEqual(tree.map((n) => n.prefix), ["├─ ", "│  ├─ ", "│  └─ ", "└─ "])
})

// BUG 3: under a LAST parent the continuation column is spaces (no stray │),
// even when an invisible root sibling sorts after that parent.
check("tree (bug 3): child under a last parent has no leading │", () => {
  const all = [
    s("A", "root", undefined, 30),
    s("A1", "A", undefined, 20),
    s("A2", "A", undefined, 10),
    s("B", "root", "succeeded", 5), // invisible, sorts last
  ]
  const visible = running({ A: "running", A1: "running", A2: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["A", "A1", "A2"])
  assert.deepEqual(tree.map((n) => n.isLast), [true, false, true])
  assert.deepEqual(tree.map((n) => n.prefix), ["└─ ", "   ├─ ", "   └─ "])
})

// BUG 2: invisible intermediate is removed and its visible descendants are
// promoted; their isLast is ranked among the promoted siblings.
check("tree (bug 2): invisible intermediate promotes children and ranks them correctly", () => {
  // Root ordering by time: X(invisible,40) -> Y1(30),Y2(20); Z(visible,10).
  // Y1,Y2 are promoted to root level; Y2 is last among them but Z follows,
  // so Y2 is ├─ and Z is └─.
  const all = [
    s("X", "root", "succeeded", 40),
    s("Y1", "X", undefined, 30),
    s("Y2", "X", undefined, 20),
    s("Z", "root", undefined, 10),
  ]
  const visible = running({ Y1: "running", Y2: "running", Z: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["Y1", "Y2", "Z"])
  assert.deepEqual(tree.map((n) => n.depth), [0, 0, 0])
  assert.deepEqual(tree.map((n) => n.isLast), [false, false, true])
  assert.deepEqual(tree.map((n) => n.prefix), ["├─ ", "├─ ", "└─ "])
})

// BUG 1/2: when the invisible intermediate itself sorts last, its promoted
// child becomes the last visible node and must render └─.
check("tree (bug 1/2): invisible last intermediate makes promoted child last", () => {
  const all = [
    s("Z", "root", undefined, 30),
    s("X", "root", "succeeded", 20),
    s("Y", "X", undefined, 10),
  ]
  const visible = running({ Z: "running", Y: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["Z", "Y"])
  assert.deepEqual(tree.map((n) => n.isLast), [false, true])
  assert.deepEqual(tree.map((n) => n.prefix), ["├─ ", "└─ "])
})

// Multi-level charset + no-│-under-last-parent assertion.
check("tree: rebuilt prefixes use only box-drawing chars and spaces", () => {
  const all = [
    s("A", "root", undefined, 90),
    s("A1", "A", undefined, 80),
    s("A2", "A", undefined, 70),
    s("X", "A", "succeeded", 65), // invisible intermediate
    s("Y", "X", undefined, 60), // promoted to A's level
    s("B", "root", undefined, 50),
    s("B1", "B", undefined, 30),
    s("B2", "B", undefined, 20),
    s("C", "root", "succeeded", 10), // invisible trailing root
  ]
  const visible = running({
    A: "running",
    A1: "running",
    A2: "running",
    Y: "running",
    B: "running",
    B1: "running",
    B2: "running",
  })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.prefix), [
    "├─ ",
    "│  ├─ ",
    "│  ├─ ",
    "│  └─ ",
    "└─ ",
    "   ├─ ",
    "   └─ ",
  ])
  for (const node of tree) {
    assert.match(node.prefix, /^[│├└─ ]*$/, `prefix "${node.prefix}" must use only │, ├, └, ─ and spaces`)
  }
})

// Cycle / malformed parentID guard: must terminate and emit a node once.
check("tree: self-referential parentID does not loop", () => {
  const all = [s("loop", "loop", undefined, 10)]
  const visible = running({ loop: "running" })
  const tree = subagentTree(all, "loop", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["loop"])
  assert.equal(tree[0].prefix, "└─ ")
})

check("treePrefix: helper emits unicode box-drawing for own/ancestor flags", () => {
  // root non-last / last
  assert.equal(treePrefix([], false), "├─ ")
  assert.equal(treePrefix([], true), "└─ ")
  // child under a non-last parent: non-last / last
  assert.equal(treePrefix([false], false), "│  ├─ ")
  assert.equal(treePrefix([false], true), "│  └─ ")
  // child under a last parent: non-last / last
  assert.equal(treePrefix([true], false), "   ├─ ")
  assert.equal(treePrefix([true], true), "   └─ ")
  // deep: first ancestor non-last, second last, node last
  assert.equal(treePrefix([false, true], true), "│     └─ ")
  // default isLast is false
  assert.equal(treePrefix([]), "├─ ")
})

// ------------------------------------- (b3) title-line continuation prefix
check("treeContinuation: exact strings for own/ancestor flags", () => {
  assert.equal(treeContinuation([]), "│  ") // default isLast=false
  assert.equal(treeContinuation([], false), "│  ")
  assert.equal(treeContinuation([], true), "   ")
  assert.equal(treeContinuation([false], true), "│     ")
  assert.equal(treeContinuation([false], false), "│  │  ")
  assert.equal(treeContinuation([true], false), "   │  ")
  assert.equal(treeContinuation([true], true), "      ")
})

check("tree: contPrefix follows the visible hierarchy (roots + nested)", () => {
  // root
  //  ├ A      (60)  <- not last, line continues to B
  //  │  ├ A1  (50)
  //  │  └ A2  (40)
  //  └ B      (30)  <- last
  //     ├ B1  (20)
  //     └ B2  (10)
  const all = [
    s("A", "root", undefined, 60),
    s("A1", "A", undefined, 50),
    s("A2", "A", undefined, 40),
    s("B", "root", undefined, 30),
    s("B1", "B", undefined, 20),
    s("B2", "B", undefined, 10),
  ]
  const visible = running({
    A: "running",
    A1: "running",
    A2: "running",
    B: "running",
    B1: "running",
    B2: "running",
  })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["A", "A1", "A2", "B", "B1", "B2"])
  assert.deepEqual(tree.map((n) => n.contPrefix), [
    "│  ", // A: not last -> continues down to B
    "│  │  ", // A1: ancestor A continues; A1 not last -> continues to A2
    "│     ", // A2: ancestor A continues; A2 last -> own segment is spaces
    "   ", // B: last -> nothing continues
    "   │  ", // B1: under last B; B1 not last -> continues to B2
    "      ", // B2: last
  ])

  // exact two-line rendering (connector line + title line)
  assert.equal(`${tree[0].prefix}A\n${tree[0].contPrefix}title of A`, "├─ A\n│  title of A")
  assert.equal(`${tree[1].prefix}A1\n${tree[1].contPrefix}title of A1`, "│  ├─ A1\n│  │  title of A1")
  assert.equal(`${tree[2].prefix}A2\n${tree[2].contPrefix}title of A2`, "│  └─ A2\n│     title of A2")
  assert.equal(`${tree[3].prefix}B\n${tree[3].contPrefix}title of B`, "└─ B\n   title of B")
})

check("tree: contPrefix length matches prefix and uses only │/spaces (incl. promoted node)", () => {
  const all = [
    s("A", "root", undefined, 50),
    s("A1", "A", undefined, 40),
    s("X", "A", "succeeded", 35), // invisible intermediate
    s("Y", "X", undefined, 30), // promoted to A's level, becomes A's last child
    s("B", "root", undefined, 20),
  ]
  const visible = running({ A: "running", A1: "running", Y: "running", B: "running" })
  const tree = subagentTree(all, "root", visible)
  assert.deepEqual(tree.map((n) => n.session.id), ["A", "A1", "Y", "B"])
  assert.deepEqual(tree.map((n) => n.contPrefix), ["│  ", "│  │  ", "│     ", "   "])
  for (const node of tree) {
    assert.equal(
      node.contPrefix.length,
      node.prefix.length,
      `contPrefix "${node.contPrefix}" must match prefix length "${node.prefix}"`,
    )
    assert.match(node.contPrefix, /^[│ ]*$/, `contPrefix "${node.contPrefix}" must use only │ and spaces`)
  }
})

// --------------------------------- (b4) visibleSubagentIDs: keep running ancestors
check("visibleSubagentIDs: a running child keeps its old DONE parent (and ancestors)", () => {
  const now = 1_000_000
  // grand is long finished; parent too; child is running now.
  const all = [
    s("grand", "root", "succeeded", 0),
    s("parent", "grand", "succeeded", 0),
    s("child", "parent", undefined, 0),
  ]
  const activity = activityMap({ child: "running" })
  assert.equal(isVisibleSubagent(all[0], "idle", now), false) // sanity: old done is invisible on its own
  const ids = visibleSubagentIDs(all, "root", activity, now)
  assert.ok(ids.has("child"), "running child must be visible")
  assert.ok(ids.has("parent"), "done parent of a running child must be kept")
  assert.ok(ids.has("grand"), "terminal ancestor of a running child must be kept")
})

check("visibleSubagentIDs: old done leaf is excluded", () => {
  const now = 1_000_000
  const all = [s("d", "root", "succeeded", now - 120_000)]
  const ids = visibleSubagentIDs(all, "root", activityMap({}), now)
  assert.equal(ids.has("d"), false)
})

check("visibleSubagentIDs: recent done leaf is included", () => {
  const now = 1_000_000
  const all = [s("d", "root", "succeeded", now - 30_000)]
  const ids = visibleSubagentIDs(all, "root", activityMap({}), now)
  assert.ok(ids.has("d"))
})

check("visibleSubagentIDs: rootID is never included", () => {
  const now = 1_000_000
  // `child` lists `root` as its parent, and an idle session also points at root.
  const all = [s("child", "root", undefined, 0), s("idle", "root", undefined, now)]
  const ids = visibleSubagentIDs(all, "root", activityMap({ child: "running" }), now)
  assert.equal(ids.has("root"), false)
  assert.ok(ids.has("child"))
})

check("visibleSubagentIDs: idle sessions are not added unless they are a running ancestor", () => {
  const now = 1_000_000
  const all = [s("idle", "root", undefined, now), s("other", "root", undefined, 0)]
  const ids = visibleSubagentIDs(all, "root", activityMap({}), now)
  assert.equal(ids.has("idle"), false)
  assert.equal(ids.has("other"), false)

  const withChild = [s("idleParent", "root", undefined, now), s("child", "idleParent", undefined, 0)]
  const ids2 = visibleSubagentIDs(withChild, "root", activityMap({ child: "running" }), now)
  assert.ok(ids2.has("idleParent"), "idle ancestor of a running child is kept")
})

// ------------------------------------------------------- (c) agent color index
const agents = [
  { id: "build" },
  { id: "plan" },
  { id: "hidden", hidden: true },
  { id: "explore" },
  { id: "general" },
]

check("agent color: same id maps to the same palette index", () => {
  const paletteLength = 12
  for (const id of ["explore", "general", "build", "plan"]) {
    assert.equal(
      agentColorIndex(agents, id, paletteLength),
      agentColorIndex(agents, id, paletteLength),
    )
  }
})

check("agent color: different ids generally differ", () => {
  const paletteLength = 12
  const ids = ["explore", "general", "build", "plan", "coder", "reviewer"]
  const indexes = new Set(ids.map((id) => agentColorIndex(agents, id, paletteLength)))
  assert.ok(indexes.size > 1, `expected several palette slots, got ${[...indexes].join(",")}`)
})

check("agent color: empty/unknown agent falls back to a stable hash slot", () => {
  const paletteLength = 12
  assert.equal(agentColorIndex(agents, undefined, paletteLength), 0)
  assert.equal(agentColorIndex(agents, "", paletteLength), 0)
  const unknown = agentColorIndex(agents, "no-such-agent", paletteLength)
  assert.ok(unknown >= 0 && unknown < paletteLength)
  assert.equal(unknown, agentColorIndex(agents, "no-such-agent", paletteLength))
})

check("agent color: known visible agent uses its visible-list position", () => {
  const paletteLength = 12
  assert.equal(agentColorIndex(agents, "build", paletteLength), 0)
  assert.equal(agentColorIndex(agents, "plan", paletteLength), 1)
  assert.equal(agentColorIndex(agents, "explore", paletteLength), 2) // hidden agent skipped
})

check("agent color: empty palette yields -1", () => {
  assert.equal(agentColorIndex(agents, "build", 0), -1)
})

check("stableHash: deterministic, integer, id-sensitive", () => {
  assert.equal(stableHash("explore"), stableHash("explore"))
  assert.notEqual(stableHash("explore"), stableHash("general"))
  assert.ok(Number.isInteger(stableHash("anything")))
})

// --------------------------------------------- (d) agent id/name casing robustness
const namedAgents = [
  { id: "build", name: "Build" },
  { id: "plan", name: "Plan" },
  { id: "hidden", name: "Hidden", hidden: true },
  { id: "explore", name: "Explore" },
  { id: "general", name: "General" },
]

check("agent color: id and display name match the same index (case-insensitive)", () => {
  const paletteLength = 12
  const fromId = agentColorIndex(namedAgents, "explore", paletteLength)
  assert.equal(fromId, 2) // hidden agent skipped
  // session.agent may hold either the id ("explore") or the display name ("Explore")
  assert.equal(agentColorIndex(namedAgents, "Explore", paletteLength), fromId)
  assert.equal(agentColorIndex(namedAgents, "EXPLORE", paletteLength), fromId)
  assert.equal(agentColorIndex(namedAgents, "explore", paletteLength), fromId)
})

check("agent color: name-only agent (no id) matches by name", () => {
  const paletteLength = 12
  const nameOnly = [{ id: "build", name: "Build" }, { name: "Explore" }]
  assert.equal(agentColorIndex(nameOnly, "explore", paletteLength), 1)
  assert.equal(agentColorIndex(nameOnly, "Explore", paletteLength), 1)
})

check("agent color: unknown agent still falls back to the stable hash", () => {
  const paletteLength = 12
  const expected = ((stableHash("no-such-agent") % paletteLength) + paletteLength) % paletteLength
  assert.equal(agentColorIndex(namedAgents, "no-such-agent", paletteLength), expected)
})

// ------------------------------------------------ (e) shorten non-string safety
check("shorten: non-string values do not throw and return strings", () => {
  for (const value of [123, {}, null, undefined]) {
    let result
    assert.doesNotThrow(() => {
      result = shorten(value, 10)
    })
    assert.equal(typeof result, "string")
  }
  assert.equal(shorten(123, 10), "123")
  assert.equal(shorten(null, 10), "")
  assert.equal(shorten(undefined, 10), "")
})

check("shorten: string behavior is unchanged", () => {
  assert.equal(shorten("hello", 10), "hello")
  assert.equal(shorten("  a   b  ", 10), "a b")
  assert.equal(shorten("abcdefghij", 6), "abcde…")
})

// ------------------------------------------------ (f) recent visibility
check("visible: RECENT_WINDOW_MS is one minute", () => {
  assert.equal(RECENT_WINDOW_MS, 60_000)
})

check("visible: running child is visible even with an old timestamp", () => {
  const now = 1_000_000
  assert.equal(isVisibleSubagent(s("r", "root", undefined, 0), "running", now), true)
})

check("visible: done child updated 30s ago is visible; 2min ago is not", () => {
  const now = 1_000_000
  assert.equal(isVisibleSubagent(s("d", "root", "succeeded", now - 30_000), "idle", now), true)
  assert.equal(isVisibleSubagent(s("d", "root", "succeeded", now - 120_000), "idle", now), false)
})

check("visible: stopped child updated 30s ago is visible; older is not", () => {
  const now = 1_000_000
  assert.equal(isVisibleSubagent(s("s", "root", "interrupted", now - 30_000), "idle", now), true)
  assert.equal(isVisibleSubagent(s("s", "root", "interrupted", now - 61_000), "idle", now), false)
})

check("visible: failed child updated 30s ago is visible", () => {
  const now = 1_000_000
  assert.equal(isVisibleSubagent(s("f", "root", "failed", now - 30_000), "idle", now), true)
})

check("visible: idle child is not visible even when recent", () => {
  const now = 1_000_000
  assert.equal(isVisibleSubagent(s("i", "root", undefined, now), "idle", now), false)
})

check("visible: custom window is honored", () => {
  const now = 1_000_000
  assert.equal(isVisibleSubagent(s("d", "root", "succeeded", now - 5_000), "idle", now, 1_000), false)
  assert.equal(isVisibleSubagent(s("d", "root", "succeeded", now - 500), "idle", now, 1_000), true)
})

check("visibleSubagents: mixes running + recent terminal, drops idle/old", () => {
  const now = 1_000_000
  const all = [
    s("run", "root", undefined, 0),
    s("fresh-done", "root", "succeeded", now - 30_000),
    s("old-done", "root", "succeeded", now - 120_000),
    s("fresh-stop", "root", "interrupted", now - 30_000),
    s("idle", "root", undefined, now),
  ]
  const kept = visibleSubagents(all, activityMap({ run: "running" }), now)
  assert.deepEqual(kept.map((x) => x.id), ["run", "fresh-done", "fresh-stop"])
})

// ------------------------------------ (g) base/muted color resolvers (color bug)
check("resolveBaseColor: prefers base, then default, tolerates junk", () => {
  assert.equal(resolveBaseColor({ base: "#fff" }), "#fff")
  assert.equal(resolveBaseColor({ default: "#eee" }), "#eee")
  assert.equal(resolveBaseColor({ base: "#fff", default: "#eee" }), "#fff")
  assert.equal(resolveBaseColor(undefined), undefined)
  assert.equal(resolveBaseColor({}), undefined)
})

check("resolveMutedColor: muted alias wins", () => {
  assert.equal(resolveMutedColor({ muted: "#abc" }, {}), "#abc")
})

check("resolveMutedColor: subdued alias (v2.0.6) wins", () => {
  assert.equal(resolveMutedColor({ subdued: "#def" }, {}), "#def")
})

check("resolveMutedColor: NEVER falls back to base/default white", () => {
  const muted = resolveMutedColor({ base: "#fff", default: "#fff" }, {})
  assert.notEqual(muted, "#fff")
  assert.equal(muted, "#808080")
})

check("resolveMutedColor: uses hue.neutral 400 when text has no muted alias", () => {
  assert.equal(resolveMutedColor({ base: "#fff" }, { neutral: { 400: "#777" } }), "#777")
})

check("resolveMutedColor: hue.neutral 300 then hardcoded grey", () => {
  assert.equal(resolveMutedColor({ base: "#fff" }, { neutral: { 300: "#666" } }), "#666")
  assert.equal(resolveMutedColor({ base: "#fff" }, {}), "#808080")
  assert.equal(resolveMutedColor(undefined, undefined), "#808080")
})

// --------------------------- (h) latestTaskDescription (stale title on resume)
// Newest `task` tool part in the PARENT messages that references the child wins.
const taskPart = (sessionId, description) => ({
  type: "tool",
  name: "task",
  state: { status: "completed", input: { description }, metadata: { sessionId } },
})

check("latestTaskDescription: newest matching task part wins (across messages and parts)", () => {
  const child = "ses_child"
  const messages = [
    { type: "assistant", content: [taskPart(child, "oldest")] },
    { type: "assistant", content: [taskPart(child, "older"), taskPart("ses_other", "other")] },
    { type: "assistant", content: [taskPart("ses_other", "ignore"), taskPart(child, "newest")] },
  ]
  assert.equal(latestTaskDescription(messages, child), "newest")
})

check("latestTaskDescription: non-matching sessionId is ignored", () => {
  const messages = [
    { type: "assistant", content: [taskPart("ses_a", "A"), taskPart("ses_b", "B")] },
  ]
  assert.equal(latestTaskDescription(messages, "ses_b"), "B")
  assert.equal(latestTaskDescription(messages, "ses_c"), undefined)
})

check("latestTaskDescription: missing metadata/description tolerated", () => {
  const messages = [
    {
      type: "assistant",
      content: [
        { type: "tool", name: "task", state: { input: { description: "no meta" } } },
        taskPart("ses_child", undefined),
        taskPart(undefined, "no session"),
      ],
    },
  ]
  assert.equal(latestTaskDescription(messages, "ses_child"), undefined)
})

check("latestTaskDescription: malformed messages/parts do not throw", () => {
  const messages = [
    null,
    42,
    "nope",
    { type: "assistant" },
    { type: "assistant", content: "bad" },
    {
      type: "assistant",
      content: [
        null,
        7,
        "x",
        {},
        { type: "tool" },
        { type: "tool", name: "task", state: null },
        { type: "tool", name: "task", state: { metadata: { sessionId: "ses_child" } } },
      ],
    },
  ]
  let result
  assert.doesNotThrow(() => {
    result = latestTaskDescription(messages, "ses_child")
  })
  assert.equal(result, undefined)
})

check("latestTaskDescription: returns undefined when there is no match", () => {
  const messages = [
    { type: "assistant", content: [{ type: "text", text: "hello" }] },
    { type: "user", text: "do a thing" },
  ]
  assert.equal(latestTaskDescription(messages, "ses_child"), undefined)
  assert.equal(latestTaskDescription([], "ses_child"), undefined)
})

check("latestTaskDescription: accepts alternate tool/metadata/description shapes", () => {
  // tool-invocation + part.tool + direct metadata + state.title
  const a = {
    type: "tool-invocation",
    tool: "task",
    metadata: { sessionId: "ses_child" },
    state: { title: "from state title" },
  }
  assert.equal(latestTaskDescription([{ content: [a] }], "ses_child"), "from state title")

  // state.input.sessionID + state.input.description
  const b = {
    type: "tool",
    name: "task",
    state: { input: { sessionID: "ses_child", description: "from input desc" } },
  }
  assert.equal(latestTaskDescription([{ content: [b] }], "ses_child"), "from input desc")

  // state.input.task_id + part.title
  const c = {
    type: "tool",
    name: "task",
    title: "part title",
    state: { input: { task_id: "ses_child" } },
  }
  assert.equal(latestTaskDescription([{ content: [c] }], "ses_child"), "part title")
})

console.log(results.join("\n"))
console.log(`\n${results.length} checks passed`)
