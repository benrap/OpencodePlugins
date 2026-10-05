/**
 * subagent-abort — server-side "abort active agent" tool for
 * subagent-sidebar-tree.
 *
 * The plugin's server entrypoint registers ONE tool, `abort_subagent`, that
 * interrupts the active execution of subagent sessions the caller spawned.
 *
 * ── API EVIDENCE (OpenCode v2.0.6, this machine) ────────────────────────────
 * Proven from the installed runtime binary
 * (the installed `opencode.exe`, 215,358,504 bytes) which
 * embeds the plaintext JS, and from a live plugin-context probe
 * (`always-background/index.probe.js`):
 *
 *   - Tool registration:
 *       ctx.tool.transform((editor) => editor.add({ ... }))
 *     `ctx.tool` keys = [reload, transform, hook]; `add` accepts
 *     `{ name, description, input: <JSON Schema>, options, execute }`.
 *     Built-in example (question tool):
 *       tool.transform((i)=>i.add({name,options:{codemode:!1},description,input,output,execute:(a,c)=>...}))
 *
 *   - Interrupt:
 *       ctx.session.interrupt({ sessionID, resume: false }) -> { interrupted }
 *     Underlying endpoint: POST /api/session/:sessionID/interrupt?resume=...
 *     (The saved V2 docs show `continue: false`, but the v2.0.6 runtime code
 *     reads `resume`; we send `resume` and fall back defensively.)
 *
 *   - Read a session + lineage:
 *       ctx.session.get({ sessionID }) -> Session.Info
 *     Session.Info fields include `{ id, parentID?, agent?, title?, outcome?,
 *     time:{ updated } }`.
 *
 *   - Events (for the session inventory):
 *       ctx.event.subscribe({ signal }) -> AsyncIterable
 *     `session.created` carries `data.parentID`; execution events carry
 *     `data.sessionID`.
 *
 *   - Permission:
 *       ctx.permission keys = [hook, list, get, reply]
 *     There is NO `assert`/`ask` on the plugin context in v2.0.6 (only a hook
 *     for reviewing decisions), so an external plugin CANNOT request the
 *     `subagent` permission action itself. The design's capability gate
 *     therefore degrades to the lineage gate: only descendants of the calling
 *     session may be aborted. `requestPermission()` below still honours an
 *     `assert`/`ask` gate if a future runtime exposes one.
 *
 * `ctx.session` in v2.0.6 exposes
 * [hook, create, get, switchAgent, switchModel, prompt, generate, command,
 *  synthetic, interrupt, update, move, wait, context] — it has NO `list`.
 * The descendant inventory for `all: true` is therefore built from
 * `ctx.event.subscribe` (same proven mechanism keep-awake uses), and explicit
 * targets are resolved live with `ctx.session.get`.
 *
 * This module MUST NOT import `@opentui/*`, `solid-js` or `@opencode/plugin`
 * so the server can resolve it without a TUI toolchain.
 */

import {
  abortTargets,
  assertAbortable,
  type SubagentSession,
} from "./subagent-view.ts"

/** A session record as tracked by the registry (SubagentSession + agent). */
export type SessionRecord = SubagentSession & { agent?: string }

export type AbortRegistry = {
  sessions: Map<string, SessionRecord>
  active: Set<string>
  controller: AbortController | null
  subscribed: boolean
}

export function createRegistry(): AbortRegistry {
  return { sessions: new Map(), active: new Set(), controller: null, subscribed: false }
}

export function listSessions(registry: AbortRegistry): SessionRecord[] {
  return [...registry.sessions.values()]
}

export function isActive(registry: AbortRegistry, sessionID: string): boolean {
  return registry.active.has(sessionID)
}

// ---------------------------------------------------------------------------
// Duck-typed plugin context (no `@opencode/plugin` import).
// ---------------------------------------------------------------------------

type MaybeSubscribe = (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>

export type AbortContext = {
  event?: { subscribe?: MaybeSubscribe }
  session?: {
    get?: (input: { sessionID: string }) => Promise<unknown>
    interrupt?: (input: Record<string, unknown>) => Promise<unknown>
  }
  permission?: { assert?: unknown; ask?: unknown }
  tool?: { transform?: (callback: (editor: AbortToolEditor) => void) => unknown }
}

type AbortToolEditor = { add?: (definition: AbortToolDefinition) => void }

export type AbortToolDefinition = {
  name: string
  description: string
  options: { codemode: boolean }
  input: Record<string, unknown>
  execute: (
    input: unknown,
    context: unknown,
  ) => Promise<{ content: string }> | { content: string }
}

export const ABORT_TOOL_NAME = "abort_subagent"

export const ABORT_TOOL_DESCRIPTION =
  "Abort the active execution of subagent sessions you spawned. Only " +
  "descendants of the calling session can be aborted; the root/primary session " +
  "is never aborted. Pass sessionID to abort a specific descendant, or all:true " +
  "to abort every running descendant. Returns the aborted session ids so you " +
  "can continue them later through the `subagent` tool with that sessionID."

const ABORT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sessionID: {
      type: "string",
      description: "Session id of a descendant subagent to abort.",
    },
    all: {
      type: "boolean",
      description: "Abort every running descendant of the calling session.",
    },
  },
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Session registry (event-fed).
// ---------------------------------------------------------------------------

const TERMINAL_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

function timeUpdated(data: Record<string, unknown>): number {
  const time = data.time
  if (time && typeof time === "object") {
    const updated = (time as Record<string, unknown>).updated
    if (typeof updated === "number" && Number.isFinite(updated)) return updated
  }
  return Date.now()
}

/**
 * Fold one runtime event into the registry. Total: malformed events are
 * ignored rather than thrown, so an event-stream hiccup can never break the
 * host or the abort tool.
 */
export function noteEvent(registry: AbortRegistry, event: unknown): void {
  if (!event || typeof event !== "object") return
  const envelope = event as { type?: unknown; data?: unknown }
  const type = typeof envelope.type === "string" ? envelope.type : ""
  if (!type) return

  const data = (
    envelope.data && typeof envelope.data === "object" ? envelope.data : {}
  ) as Record<string, unknown>
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (!sessionID) return

  if (type === "session.created") {
    registry.sessions.set(sessionID, {
      id: sessionID,
      parentID: typeof data.parentID === "string" ? data.parentID : undefined,
      agent: typeof data.agent === "string" ? data.agent : undefined,
      title: typeof data.title === "string" ? data.title : undefined,
      outcome: undefined,
      time: { updated: timeUpdated(data) },
    })
    return
  }

  if (type === "session.deleted" || type === "session.removed") {
    registry.sessions.delete(sessionID)
    registry.active.delete(sessionID)
    return
  }

  if (type === "session.execution.started") {
    registry.active.add(sessionID)
    // A restarted/continued session is live again: clear any outcome left by
    // its previous terminal event, otherwise it stays "terminal" forever and
    // can never be aborted on a later run.
    const restarted = registry.sessions.get(sessionID)
    if (restarted) {
      restarted.outcome = undefined
      restarted.time.updated = timeUpdated(data)
    }
    return
  }

  if (TERMINAL_EVENTS.has(type)) {
    registry.active.delete(sessionID)
    const session = registry.sessions.get(sessionID)
    if (session) {
      session.outcome =
        type === "session.execution.interrupted"
          ? "interrupted"
          : type === "session.execution.failed"
            ? "failed"
            : "succeeded"
      session.time.updated = timeUpdated(data)
    }
    return
  }

  if (type === "session.status") {
    const status = (
      data.status && typeof data.status === "object" ? data.status : {}
    ) as Record<string, unknown>
    const kind = typeof status.type === "string" ? status.type : ""
    if (kind === "busy" || kind === "retry") registry.active.add(sessionID)
    else if (kind === "idle" || kind === "error") registry.active.delete(sessionID)
    return
  }

  if (type === "session.updated" || type === "session.renamed") {
    const session = registry.sessions.get(sessionID)
    if (session) {
      if (typeof data.title === "string") session.title = data.title
      if (typeof data.agent === "string") session.agent = data.agent
      session.time.updated = timeUpdated(data)
    }
  }
}

const REGISTRY_KEY = Symbol.for("opencode.subagent-sidebar-tree.abort-registry.v1")

/** Process-wide registry; survives the host re-evaluating the plugin module. */
export function globalRegistry(): AbortRegistry {
  const store = globalThis as unknown as Record<symbol, AbortRegistry | undefined>
  let registry = store[REGISTRY_KEY]
  if (!registry) {
    registry = createRegistry()
    store[REGISTRY_KEY] = registry
  }
  return registry
}

/** Subscribe once to the host event stream and fold session events in. */
export function subscribeRegistry(
  ctx: AbortContext | undefined,
  registry: AbortRegistry,
): void {
  if (registry.subscribed) return
  const subscribe = ctx?.event?.subscribe
  if (typeof subscribe !== "function") return
  registry.subscribed = true
  const controller = new AbortController()
  registry.controller = controller

  void (async () => {
    try {
      const stream = await subscribe({ signal: controller.signal })
      for await (const event of stream) {
        if (controller.signal.aborted) break
        try {
          noteEvent(registry, event)
        } catch {
          /* ignore a single malformed event */
        }
      }
    } catch {
      /* the event stream is best-effort; the tool still works on explicit ids */
    } finally {
      registry.subscribed = false
      if (registry.controller === controller) registry.controller = null
    }
  })()
}

// ---------------------------------------------------------------------------
// Tool definition + installation.
// ---------------------------------------------------------------------------

export function makeAbortTool(
  ctx: AbortContext | undefined,
  registry: AbortRegistry,
): AbortToolDefinition {
  return {
    name: ABORT_TOOL_NAME,
    description: ABORT_TOOL_DESCRIPTION,
    options: { codemode: false },
    input: ABORT_INPUT_SCHEMA,
    execute: (input, context) => executeAbort(ctx, registry, input, context),
  }
}

/**
 * Register the abort tool. Safe to call with `undefined` (the server-safe test
 * does) or a context without `tool.transform`: it becomes a no-op.
 */
export function installAbortTool(ctx: unknown): void {
  const context = (ctx && typeof ctx === "object" ? ctx : undefined) as
    | AbortContext
    | undefined
  const transform = context?.tool?.transform
  if (typeof transform !== "function") return

  const registry = globalRegistry()
  subscribeRegistry(context, registry)

  try {
    const result = transform((editor) => {
      if (!editor || typeof editor.add !== "function") return
      editor.add(makeAbortTool(context, registry))
    })
    if (result && typeof (result as { catch?: unknown }).catch === "function") {
      void (result as Promise<unknown>).catch(() => {})
    }
  } catch {
    /* never break host startup */
  }
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

function callerSessionID(toolContext: unknown): string | undefined {
  if (!toolContext || typeof toolContext !== "object") return undefined
  const value = (toolContext as { sessionID?: unknown }).sessionID
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function normalizeOutcome(value: unknown): SubagentSession["outcome"] {
  return value === "succeeded" || value === "failed" || value === "interrupted"
    ? value
    : undefined
}

function timeOf(value: unknown): number {
  if (value && typeof value === "object") {
    const updated = (value as Record<string, unknown>).updated
    if (typeof updated === "number" && Number.isFinite(updated)) return updated
  }
  return Date.now()
}

async function fetchSession(
  ctx: AbortContext | undefined,
  sessionID: string,
): Promise<SessionRecord | undefined> {
  const get = ctx?.session?.get
  if (typeof get !== "function") return undefined
  try {
    const info = await get({ sessionID })
    if (!info || typeof info !== "object") return undefined
    const record = info as Record<string, unknown>
    if (typeof record.id !== "string" || !record.id) return undefined
    return {
      id: record.id,
      parentID: typeof record.parentID === "string" ? record.parentID : undefined,
      agent: typeof record.agent === "string" ? record.agent : undefined,
      title: typeof record.title === "string" ? record.title : undefined,
      outcome: normalizeOutcome(record.outcome),
      time: { updated: timeOf(record.time) },
    }
  } catch {
    return undefined
  }
}

/** Fetch `id` (optionally refreshing it) and walk its ancestors into `byID`. */
async function fetchChain(
  ctx: AbortContext | undefined,
  byID: Map<string, SessionRecord>,
  id: string | undefined,
  refresh: boolean,
  depth = 0,
): Promise<void> {
  if (!id || depth > 64) return
  if (refresh || !byID.has(id)) {
    const info = await fetchSession(ctx, id)
    if (info) byID.set(info.id, info)
  }
  const parentID = byID.get(id)?.parentID
  if (parentID) await fetchChain(ctx, byID, parentID, false, depth + 1)
}

type InterruptOutcome = { interrupted: boolean; raw?: unknown }

function interruptResult(value: unknown): { interrupted?: boolean; error?: string } {
  if (!value || typeof value !== "object") return {}
  const record = value as Record<string, unknown>
  // Surface an error carried in the response body rather than treating it as success.
  if (typeof record.error === "string" && record.error) return { error: record.error }
  if (record.data && typeof record.data === "object") {
    return interruptResult(record.data)
  }
  if (typeof record.interrupted === "boolean") return { interrupted: record.interrupted }
  return {}
}

async function interrupt(
  ctx: AbortContext | undefined,
  sessionID: string,
): Promise<InterruptOutcome> {
  const fn = ctx?.session?.interrupt
  if (typeof fn !== "function") {
    throw new Error("session.interrupt is unavailable on this runtime")
  }
  // v2.0.6 reads `resume`; older/newer builds may read `continue` or nothing.
  const attempts: Record<string, unknown>[] = [
    { sessionID, resume: false },
    { sessionID, continue: false },
    { sessionID },
  ]
  let last: unknown
  for (const arg of attempts) {
    try {
      const value = await fn(arg)
      const parsed = interruptResult(value)
      if (parsed.error) throw new Error(parsed.error)
      // `interrupted` is only false when the server reports an idle no-op. Absence
      // of the field (older runtimes) is treated as success.
      return { interrupted: parsed.interrupted !== false, raw: value }
    } catch (error) {
      last = error
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

function pickPermissionGate(
  ctx: AbortContext | undefined,
  toolContext: unknown,
): { fn: (...args: unknown[]) => unknown; owner: unknown } | undefined {
  const owners: unknown[] = [ctx?.permission]
  if (toolContext && typeof toolContext === "object") {
    owners.push((toolContext as { permission?: unknown }).permission)
    const toolAsk = (toolContext as { ask?: unknown }).ask
    if (typeof toolAsk === "function") return { fn: toolAsk as (...a: unknown[]) => unknown, owner: toolContext }
  }
  for (const owner of owners) {
    if (!owner || typeof owner !== "object") continue
    const assert = (owner as { assert?: unknown }).assert
    if (typeof assert === "function") {
      return { fn: assert as (...a: unknown[]) => unknown, owner }
    }
    const ask = (owner as { ask?: unknown }).ask
    if (typeof ask === "function") {
      return { fn: ask as (...a: unknown[]) => unknown, owner }
    }
  }
  return undefined
}

/**
 * Capability gate. On v2.0.6 the plugin context has no permission `assert`/`ask`
 * (only `hook`/`list`/`get`/`reply`), so this returns ok and the lineage gate in
 * `assertAbortable` is the enforcement. If a future runtime exposes
 * `permission.assert`/`permission.ask`, it is called with the SAME action as
 * subagent spawning: `subagent` with the target agent id as the resource.
 */
async function requestPermission(
  ctx: AbortContext | undefined,
  toolContext: unknown,
  caller: string,
  target: SessionRecord,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gate = pickPermissionGate(ctx, toolContext)
  if (!gate) return { ok: true }
  try {
    await gate.fn.call(gate.owner, {
      action: "subagent",
      resources: target.agent ? [target.agent] : ["*"],
      sessionID: caller,
      save: [],
      metadata: { abortedBy: ABORT_TOOL_NAME },
    })
    return { ok: true }
  } catch {
    return { ok: false, reason: "permission-denied" }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function content(payload: unknown): { content: string } {
  return { content: JSON.stringify(payload) }
}

export type AbortFailure = { sessionID: string; reason: string; message?: string }
export type AbortResult = { aborted: string[]; failures: AbortFailure[]; error?: string }

/**
 * Execute the abort tool. Exported so the unit suite can drive it with a mock
 * plugin context (no live OpenCode server required).
 */
export async function executeAbort(
  ctx: AbortContext | undefined,
  registry: AbortRegistry,
  input: unknown,
  toolContext: unknown,
): Promise<{ content: string }> {
  const caller = callerSessionID(toolContext)
  const params = (input && typeof input === "object" ? input : {}) as {
    sessionID?: unknown
    all?: unknown
  }
  const explicit =
    typeof params.sessionID === "string" && params.sessionID.trim()
      ? [params.sessionID.trim()]
      : []
  const all = params.all === true

  if (!caller) {
    return content({
      aborted: [],
      failures: [],
      error: "caller session could not be determined",
    })
  }

  const byID = new Map<string, SessionRecord>(registry.sessions)
  await fetchChain(ctx, byID, caller, true)
  for (const id of explicit) await fetchChain(ctx, byID, id, true)

  const sessions = [...byID.values()]
  const activityOf = all
    ? (session: SubagentSession) =>
        registry.active.has(session.id) ? ("running" as const) : ("idle" as const)
    : undefined

  const targets = abortTargets(caller, sessions, { all, sessionID: explicit, activityOf })
  const aborted: string[] = []
  const failures: AbortFailure[] = []

  for (const target of targets) {
    const verdict = assertAbortable(caller, target, byID)
    if (!verdict.ok) {
      failures.push({ sessionID: target.id, reason: verdict.reason })
      continue
    }
    const gate = await requestPermission(ctx, toolContext, caller, target)
    if (!gate.ok) {
      failures.push({ sessionID: target.id, reason: gate.reason })
      continue
    }
    try {
      const outcome = await interrupt(ctx, target.id)
      if (outcome.interrupted === false) {
        failures.push({ sessionID: target.id, reason: "not-running" })
      } else {
        aborted.push(target.id)
      }
    } catch (error) {
      failures.push({
        sessionID: target.id,
        reason: "interrupt-failed",
        message: messageOf(error),
      })
    }
  }

  return content({ aborted, failures })
}
