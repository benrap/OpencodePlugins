/**
 * subagent-registry — dependency-free, pure ESM session registry for the
 * `subagent-status` plugin's `all` mode.
 *
 * OpenCode v2.0.6's plugin context has NO `ctx.session.list`, so session
 * inventory has to be built by folding the host event stream
 * (`ctx.event.subscribe`) into a small in-memory map. This module ports the
 * proven mechanism from `subagent-abort/subagent-abort.ts`, scoped and
 * extended with the two extra fields the status tool needs:
 *
 *   - `active`  — the session currently has an execution in flight
 *   - `waiting` — the session's turn settled but background work is pending
 *
 * Everything here is TOTAL: malformed events/records are ignored rather than
 * thrown, so an event-stream hiccup can never break the host or the tool.
 * It imports nothing (not even the sibling view module) so the server can
 * resolve it without a TUI toolchain.
 */

/**
 * @typedef {Object} SessionRecord
 * @property {string} id
 * @property {string} [parentID]
 * @property {string} [name]
 * @property {string} [agent]
 * @property {'succeeded'|'failed'|'interrupted'} [outcome]
 * @property {boolean} active
 * @property {boolean} waiting
 * @property {{ updated: number }} time
 */

/**
 * @typedef {Object} Registry
 * @property {Map<string, SessionRecord>} sessions
 * @property {Set<string>} active
 * @property {boolean} subscribed
 * @property {AbortController|null} controller
 */

/** Create an empty registry. */
export function createRegistry() {
  return {
    sessions: new Map(),
    active: new Set(),
    controller: null,
    subscribed: false,
  };
}

/** Terminal execution event -> recorded outcome. */
const TERMINAL_OUTCOMES = {
  'session.execution.succeeded': 'succeeded',
  'session.execution.failed': 'failed',
  'session.execution.interrupted': 'interrupted',
};

function isRegistry(registry) {
  return (
    registry !== null &&
    typeof registry === 'object' &&
    registry.sessions instanceof Map &&
    registry.active instanceof Set
  );
}

/** Best-effort timestamp from `data.time.updated`, else `Date.now()`. */
function timeUpdated(data) {
  if (data && typeof data === 'object') {
    const time = data.time;
    if (time && typeof time === 'object') {
      const updated = time.updated;
      if (typeof updated === 'number' && Number.isFinite(updated)) return updated;
    }
  }
  return Date.now();
}

/**
 * Fold one runtime event into the registry.
 *
 * Total: malformed events are ignored rather than thrown. Unknown event types
 * are ignored. `data` falls back to `{}` when missing/non-object.
 *
 * @param {Registry} registry
 * @param {unknown} event
 */
export function noteEvent(registry, event) {
  if (!isRegistry(registry)) return;
  if (!event || typeof event !== 'object') return;

  const type = typeof event.type === 'string' ? event.type : '';
  if (!type) return;

  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const sessionID =
    typeof data.sessionID === 'string' && data.sessionID ? data.sessionID : undefined;
  if (!sessionID) return;

  const { sessions, active } = registry;

  if (type === 'session.created') {
    sessions.set(sessionID, {
      id: sessionID,
      parentID: typeof data.parentID === 'string' ? data.parentID : undefined,
      name: typeof data.title === 'string' ? data.title : undefined,
      agent: typeof data.agent === 'string' ? data.agent : undefined,
      outcome: undefined,
      active: false,
      waiting: false,
      time: { updated: timeUpdated(data) },
    });
    return;
  }

  if (type === 'session.deleted' || type === 'session.removed') {
    sessions.delete(sessionID);
    active.delete(sessionID);
    return;
  }

  if (type === 'session.execution.started') {
    active.add(sessionID);
    const record = sessions.get(sessionID);
    if (record) {
      // A restarted/continued session is live again: clear any outcome left by
      // its previous terminal event.
      record.active = true;
      record.waiting = false;
      record.outcome = undefined;
      record.time.updated = timeUpdated(data);
    }
    return;
  }

  const terminalOutcome = TERMINAL_OUTCOMES[type];
  if (terminalOutcome !== undefined) {
    active.delete(sessionID);
    const record = sessions.get(sessionID);
    if (record) {
      record.active = false;
      record.waiting = false;
      record.outcome = terminalOutcome;
      record.time.updated = timeUpdated(data);
    }
    return;
  }

  if (type === 'session.status') {
    const status = data.status && typeof data.status === 'object' ? data.status : {};
    const kind = typeof status.type === 'string' ? status.type : '';
    let nextActive;
    let nextWaiting = false;
    if (kind === 'busy' || kind === 'retry') {
      active.add(sessionID);
      nextActive = true;
    } else if (kind === 'idle' || kind === 'error') {
      active.delete(sessionID);
      nextActive = false;
    } else if (kind === 'waiting') {
      active.add(sessionID);
      nextActive = true;
      nextWaiting = true;
    } else {
      return; // unknown status kind
    }
    const record = sessions.get(sessionID);
    if (record) {
      record.active = nextActive;
      record.waiting = nextWaiting;
      record.time.updated = timeUpdated(data);
    }
    return;
  }

  if (type === 'session.updated' || type === 'session.renamed') {
    const record = sessions.get(sessionID);
    if (record) {
      if (typeof data.title === 'string') record.name = data.title;
      if (typeof data.agent === 'string') record.agent = data.agent;
      record.time.updated = timeUpdated(data);
    }
    return;
  }

  // Anything else: ignore.
}

/**
 * Map a record to its state string. Total — never throws.
 * `'running'` | `'waiting'` | `'done'` | `'failed'` | `'stopped'` | `'idle'`.
 *
 * @param {SessionRecord} record
 * @returns {'running'|'waiting'|'done'|'failed'|'stopped'|'idle'}
 */
export function sessionState(record) {
  if (!record || typeof record !== 'object') return 'idle';
  if (record.waiting) return 'waiting';
  if (record.active) return 'running';
  switch (record.outcome) {
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'stopped';
    default:
      return 'idle';
  }
}

/**
 * Human-readable name for a record: `name` (session title), else `agent`, else
 * `id`. Always a trimmed string; empty-safe.
 *
 * @param {SessionRecord} record
 * @returns {string}
 */
export function resolveName(record) {
  if (!record || typeof record !== 'object') return '';
  for (const candidate of [record.name, record.agent, record.id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/**
 * True only for an ACTIVE subagent: it has a parent (so it is not the
 * root/primary session) and its state is `running` or `waiting`. Terminal and
 * idle sessions are excluded.
 *
 * @param {SessionRecord} record
 * @returns {boolean}
 */
export function isActiveSubagent(record) {
  if (!record || typeof record !== 'object') return false;
  if (!record.parentID) return false;
  const state = sessionState(record);
  return state === 'running' || state === 'waiting';
}

/**
 * All active subagent records, sorted by `time.updated` DESC (ties broken by
 * id ascending). Total — never throws.
 *
 * @param {Registry} registry
 * @returns {SessionRecord[]}
 */
export function activeSubagentSessions(registry) {
  if (!isRegistry(registry)) return [];
  const out = [];
  try {
    for (const record of registry.sessions.values()) {
      if (isActiveSubagent(record)) out.push(record);
    }
  } catch {
    return out;
  }
  out.sort((a, b) => {
    const aTime = a && a.time && typeof a.time.updated === 'number' ? a.time.updated : 0;
    const bTime = b && b.time && typeof b.time.updated === 'number' ? b.time.updated : 0;
    if (bTime !== aTime) return bTime - aTime;
    const aID = typeof a.id === 'string' ? a.id : '';
    const bID = typeof b.id === 'string' ? b.id : '';
    return aID < bID ? -1 : aID > bID ? 1 : 0;
  });
  return out;
}

const REGISTRY_KEY = Symbol.for('opencode.subagent-status.registry.v1');

/** Process-wide registry; survives the host re-evaluating the plugin module. */
export function globalRegistry() {
  const store = globalThis;
  let registry = store[REGISTRY_KEY];
  if (!registry) {
    registry = createRegistry();
    store[REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * Subscribe ONCE to the host event stream and fold session events in.
 *
 * Safe to call with `undefined` or a context lacking `ctx.event.subscribe`:
 * it becomes a no-op. Never throws into the caller.
 *
 * @param {{ event?: { subscribe?: (options?: { signal?: AbortSignal }) => unknown } } | undefined} ctx
 * @param {Registry} registry
 */
export function subscribeRegistry(ctx, registry) {
  try {
    if (!isRegistry(registry)) return;
    if (registry.subscribed) return;
    const subscribe = ctx && ctx.event && ctx.event.subscribe;
    if (typeof subscribe !== 'function') return;
    registry.subscribed = true;
    const controller = new AbortController();
    registry.controller = controller;

    void (async () => {
      try {
        const stream = await subscribe({ signal: controller.signal });
        // eslint-disable-next-line no-unreachable-loop
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          try {
            noteEvent(registry, event);
          } catch {
            /* ignore a single malformed event */
          }
        }
      } catch {
        /* the event stream is best-effort */
      } finally {
        registry.subscribed = false;
        if (registry.controller === controller) registry.controller = null;
      }
    })();
  } catch {
    /* never throw into the caller */
  }
}
