/**
 * keep-awake — OpenCode V2 plugin
 *
 * Keeps a Windows machine awake (no sleep; the display may power off) while any
 * OpenCode session/agent is busy.
 *
 * Dependency-free plain object plugin: `export default { id, setup }`.
 * Works on OpenCode V2 (opencode2). On non-Windows hosts it is a no-op.
 *
 * Busy/idle detection — verified against the running OpenCode v2.0.6 event
 * stream (captured live from `opencode run --standalone`):
 *
 *   Busy: `session.execution.started`
 *   Idle: `session.execution.succeeded` | `session.execution.failed`
 *         | `session.execution.interrupted`
 *
 * Event payloads use `event.data` (not `event.properties`); the session id is
 * `event.data.sessionID`:
 *   {"id":"…","created":…,"type":"session.execution.started",
 *    "durable":{…},"data":{"sessionID":"ses_…"}}
 *
 * Back-compat fallbacks for the SDK-documented V2 events are handled too:
 *   `session.status` (data.status.type busy/retry/idle/error), `session.idle`,
 *   `session.error`.
 *
 * SINGLETON: OpenCode V2 may evaluate this module and call `setup(ctx)` several
 * times in one server process (plugin reconciliation). All invocations share
 * one process-wide state object on `globalThis`, one event subscription, and
 * one helper process, ref-counted by active `session.execution.started`
 * sessions. Teardown only runs when the last `setup` cleanup executes. The
 * PowerShell helper additionally takes a global named mutex so at most one
 * OpenCode process holds the power request across processes.
 *
 * The host power mechanism lives in keep-awake.ps1 (Power Request API with a
 * SetThreadExecutionState fallback).
 *
 * Options (object form in opencode.jsonc):
 *   { "package": "…/plugins/keep-awake", "options": {
 *       "releaseDelayMs": 1500, "maxSeconds": 43200, "debug": false } }
 *
 * Diagnostics: set env KEEP_AWAKE_DEBUG_FILE to a path to append a trace.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, 'keep-awake.ps1');

const TAG = '[keep-awake]';
const DEBUG_FILE = process.env.KEEP_AWAKE_DEBUG_FILE;
const DEFAULTS = { releaseDelayMs: 1500, maxSeconds: 43200, debug: false };

// Sentinel Set key for events that carry no usable session id. Chosen so it
// cannot collide with a real `ses_…` id.
export const UNKNOWN_KEY = '\u0000keep-awake-unknown';

function dbg(msg) {
  if (!DEBUG_FILE) return;
  try { fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}
function log(...args) {
  try { console.log(TAG, ...args); } catch { /* never break the host */ }
}
function warn(...args) {
  try { console.error(TAG, ...args); } catch { /* never break the host */ }
}

const EXEC_STARTED = 'session.execution.started';
const EXEC_ENDED = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

function sessionIdOf(event) {
  const d = event && event.data;
  if (d && typeof d === 'object') {
    if (typeof d.sessionID === 'string') return d.sessionID;
    if (typeof d.sessionId === 'string') return d.sessionId;
  }
  if (typeof event.sessionID === 'string') return event.sessionID;
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).
// ---------------------------------------------------------------------------

// Normalize a raw event session id to a Set key. A non-empty string is used
// as-is; anything else collapses to the shared UNKNOWN_KEY sentinel.
export function normalizeSessionKey(rawId) {
  return (typeof rawId === 'string' && rawId.length > 0) ? rawId : UNKNOWN_KEY;
}

// Mark a session busy. Idempotent; returns the normalized key that was added.
export function busyAcquire(busy, rawId) {
  const key = normalizeSessionKey(rawId);
  busy.add(key);
  return key;
}

// Clear a session's busy mark, leak-proof against mismatched ids.
//
// Heuristic (a mismatched/absent id must never strand an entry forever):
//   - Real id present in the set        -> delete it.
//   - Real id absent, sentinel present   -> delete UNKNOWN_KEY (reconciles a
//     `started` with no id followed by a terminal event that did carry one).
//   - No usable id                       -> delete UNKNOWN_KEY if present (so an
//     id-less end mirrors the id-less start that added it); otherwise delete ONE
//     entry (insertion-order first) so the set cannot become permanently
//     non-empty.
// Returns true when an entry was removed.
export function busyEnd(busy, rawId) {
  if (typeof rawId === 'string' && rawId.length > 0) {
    if (busy.has(rawId)) { busy.delete(rawId); return true; }
    if (busy.has(UNKNOWN_KEY)) { busy.delete(UNKNOWN_KEY); return true; }
    return false;
  }
  if (busy.has(UNKNOWN_KEY)) { busy.delete(UNKNOWN_KEY); return true; }
  const first = busy.values().next();
  if (first.done) return false;
  busy.delete(first.value);
  return true;
}

// Seconds left in the cumulative awake budget. `awakeSinceMs` is null when no
// busy period has started, in which case the full cap remains.
export function remainingCapSeconds(awakeSinceMs, maxSeconds, nowMs) {
  const max = Number.isFinite(maxSeconds) ? maxSeconds : DEFAULTS.maxSeconds;
  if (!Number.isFinite(awakeSinceMs)) return max;
  return max - (nowMs - awakeSinceMs) / 1000;
}

// Whether it is safe/useful to (re)spawn the helper right now.
export function canSpawnHelper({ proc, setupRefs, busyCount: busyN, remainingSeconds }) {
  if (proc) return false;
  if (!(setupRefs > 0)) return false;
  if (!(busyN > 0)) return false;
  if (!(remainingSeconds > 0)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Process-wide singleton state. OpenCode may re-evaluate this module per
// setup() invocation, so state must live on globalThis (shared by all module
// instances in the same realm) rather than in module-level variables.
// ---------------------------------------------------------------------------
const STATE_KEY = Symbol.for('opencode.keep-awake.state.v1');

function getState() {
  let s = globalThis[STATE_KEY];
  if (!s) {
    s = {
      cfg: { ...DEFAULTS },
      busy: new Set(),      // sessionID -> busy
      awakeSince: null,     // Date.now() when the cumulative busy period began
      capWarned: false,     // cumulative-cap warning already emitted this period
      proc: null,           // active helper child process
      ready: false,         // helper printed READY
      releaseTimer: null,   // debounce before killing the helper
      cleanupTimer: null,   // grace window when the last setup() unloads while busy
      setupRefs: 0,         // number of live setup() invocations
      controller: null,     // event subscription AbortController
    };
    globalThis[STATE_KEY] = s;
    dbg('created global keep-awake state');
  }
  return s;
}

function busyCount(S) {
  return S.busy.size;
}

function startHelper(S) {
  if (S.proc) return;
  const remaining = remainingCapSeconds(S.awakeSince, S.cfg.maxSeconds, Date.now());
  if (!canSpawnHelper({
    proc: S.proc,
    setupRefs: S.setupRefs,
    busyCount: busyCount(S),
    remainingSeconds: remaining,
  })) {
    // Cumulative cap reached (or not actually needed): do not spawn, and do
    // not reset the clock by re-spawning with a full maxSeconds.
    if (busyCount(S) > 0 && S.setupRefs > 0 && remaining <= 0 && !S.capWarned) {
      S.capWarned = true;
      warn(`cumulative awake cap reached (maxSeconds=${S.cfg.maxSeconds}); not spawning helper`);
      dbg('startHelper skipped: cumulative cap reached');
    }
    return;
  }
  let child;
  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', HELPER,
        '-ParentPid', String(process.pid),
        '-MaxSeconds', String(Math.max(1, Math.ceil(remaining))),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
  } catch (err) {
    warn('failed to spawn helper:', err && err.message ? err.message : err);
    return;
  }

  S.proc = child;
  dbg(`helper spawned pid=${child.pid}`);

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (!S.ready && /READY\b/.test(buf)) {
      S.ready = true;
      log('holding awake:', buf.trim().replace(/\s+/g, ' '));
      dbg('helper READY');
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text && (S.cfg.debug || DEBUG_FILE)) warn('helper stderr:', text);
  });
  child.on('error', (err) => {
    warn('helper process error:', err && err.message ? err.message : err);
    // A failed spawn never emits 'exit'; clear state so a later acquire retries.
    if (S.proc === child) { S.proc = null; S.ready = false; }
  });
  child.on('exit', (code, signal) => {
    const wasReady = S.ready;
    S.proc = null;
    S.ready = false;
    dbg(`helper exited code=${code} signal=${signal} wasReady=${wasReady}`);
    // Recover if sessions are still busy (e.g. helper crashed), but respect
    // the cumulative cap so a leak cannot re-arm the helper forever.
    if (canSpawnHelper({
      proc: S.proc,
      setupRefs: S.setupRefs,
      busyCount: busyCount(S),
      remainingSeconds: remainingCapSeconds(S.awakeSince, S.cfg.maxSeconds, Date.now()),
    })) {
      const t = setTimeout(() => {
        if (canSpawnHelper({
          proc: S.proc,
          setupRefs: S.setupRefs,
          busyCount: busyCount(S),
          remainingSeconds: remainingCapSeconds(S.awakeSince, S.cfg.maxSeconds, Date.now()),
        })) startHelper(S);
      }, 1000);
      if (t.unref) t.unref();
    }
  });

  const watchdog = setTimeout(() => {
    if (S.proc === child && !S.ready) {
      warn('helper has not reported READY after 10s');
      dbg('helper READY watchdog fired');
    }
  }, 10000);
  if (watchdog.unref) watchdog.unref();
}

function acquire(S, sessionID) {
  const wasEmpty = S.busy.size === 0;
  const key = busyAcquire(S.busy, sessionID);
  if (wasEmpty) {
    // A new cumulative busy period starts now; the cap clock runs once per
    // period, not per event.
    S.awakeSince = Date.now();
    S.capWarned = false;
  }
  if (S.releaseTimer) {
    clearTimeout(S.releaseTimer);
    S.releaseTimer = null;
  }
  startHelper(S);
  if (S.cfg.debug || DEBUG_FILE) dbg(`acquire session=${key} busy=${busyCount(S)}`);
}

function killHelper(S, reason) {
  S.releaseTimer = null;
  if (!S.proc) return;
  const child = S.proc;
  S.proc = null;
  S.ready = false;
  log(`release (${reason})`);
  dbg(`killHelper reason=${reason} pid=${child.pid}`);
  try { child.kill(); } catch (err) { warn('kill failed:', err && err.message ? err.message : err); }
  if (child.pid) {
    // Belt-and-braces: kill() is enough for powershell.exe, but taskkill
    // guarantees the whole tree (and therefore the power request) goes.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => {});
    } catch { /* ignore */ }
  }
}

function release(S) {
  if (busyCount(S) > 0 || !S.proc || S.releaseTimer) return;
  S.releaseTimer = setTimeout(() => killHelper(S, 'idle'), S.cfg.releaseDelayMs);
  if (S.releaseTimer.unref) S.releaseTimer.unref();
  if (S.cfg.debug || DEBUG_FILE) dbg(`release scheduled in ${S.cfg.releaseDelayMs}ms`);
}

function endBusy(S, rawId) {
  const removed = busyEnd(S.busy, rawId);
  if (busyCount(S) === 0) S.awakeSince = null;
  release(S);
  return removed;
}

function handle(S, event) {
  try {
    const type = event && event.type;
    if (typeof type !== 'string') return;
    const rawId = sessionIdOf(event);

    if (type === EXEC_STARTED) {
      acquire(S, rawId);
      return;
    }
    if (EXEC_ENDED.has(type)) {
      endBusy(S, rawId);
      return;
    }

    // Forward/back-compat with the SDK-documented V2 event names.
    // status.type: busy/retry => still working (acquire); idle/error => ended.
    if (type === 'session.status') {
      const d = event.data || event.properties || {};
      const status = d.status && d.status.type;
      if (status === 'busy' || status === 'retry') acquire(S, rawId);
      else if (status === 'idle' || status === 'error') endBusy(S, rawId);
      return;
    }
    if (type === 'session.idle') { endBusy(S, rawId); return; }
    if (type === 'session.error') { endBusy(S, rawId); return; }
  } catch (err) {
    warn('event handling failed:', err && err.message ? err.message : err);
  }
}

function ensureSubscription(S, ctx) {
  if (S.controller) return;
  const local = new AbortController();
  S.controller = local;
  (async () => {
    try {
      dbg('subscribing to event stream');
      const stream = await ctx.event.subscribe({ signal: local.signal });
      dbg('subscribed; entering iteration');
      for await (const event of stream) {
        if (DEBUG_FILE && event && typeof event.type === 'string') {
          const acted = event.type === EXEC_STARTED || EXEC_ENDED.has(event.type)
            || event.type === 'session.status' || event.type === 'session.idle'
            || event.type === 'session.error';
          if (acted) dbg(`event ${event.type} session=${sessionIdOf(event) || '-'}`);
        }
        handle(S, event);
      }
      dbg('event stream ended');
    } catch (err) {
      dbg(`subscribe/iterate error: ${err && err.stack ? err.stack : String(err)}`);
      if (!local.signal.aborted) {
        warn('event subscription failed:', err && err.message ? err.message : err);
      }
    } finally {
      if (S.controller === local) S.controller = null;
    }
  })();
}

async function setup(ctx) {
  try {
    if (process.platform !== 'win32') {
      log('inactive: host is not Windows');
      return;
    }
    if (!fs.existsSync(HELPER)) {
      warn(`helper missing at ${HELPER}; staying inactive`);
      return;
    }
    if (!ctx || !ctx.event || typeof ctx.event.subscribe !== 'function') {
      warn('ctx.event.subscribe unavailable; staying inactive');
      return;
    }

    const S = getState();
    S.setupRefs++;
    if (S.cleanupTimer) {
      // A transient unload (V2 hot-reload) is being undone; keep the helper.
      clearTimeout(S.cleanupTimer);
      S.cleanupTimer = null;
      dbg('re-setup before cleanup grace expired; keeping helper');
    }
    if (S.setupRefs === 1) {
      const options = (ctx && ctx.options) || {};
      S.cfg = {
        releaseDelayMs: Number.isFinite(options.releaseDelayMs) ? Math.max(0, options.releaseDelayMs) : DEFAULTS.releaseDelayMs,
        maxSeconds: Number.isFinite(options.maxSeconds) ? options.maxSeconds : DEFAULTS.maxSeconds,
        debug: options.debug === true,
      };
    }
    dbg(`setup called refs=${S.setupRefs} pid=${process.pid}`);
    ensureSubscription(S, ctx);
    log(`active on Windows (refs=${S.setupRefs}, releaseDelayMs=${S.cfg.releaseDelayMs}, maxSeconds=${S.cfg.maxSeconds})`);

    return () => {
      S.setupRefs = Math.max(0, S.setupRefs - 1);
      dbg(`cleanup called refs=${S.setupRefs}`);
      if (S.setupRefs > 0) return; // other setup() invocations still live
      // Last one out: stop listening.
      try { if (S.controller) S.controller.abort(); } catch { /* ignore */ }
      S.controller = null;
      if (S.releaseTimer) { clearTimeout(S.releaseTimer); S.releaseTimer = null; }
      if (S.cleanupTimer) { clearTimeout(S.cleanupTimer); S.cleanupTimer = null; }
      if (busyCount(S) > 0) {
        // OpenCode V2 hot-reloads plugins; a session may still be busy. Hold the
        // request for a short grace window, then release if setup never returns.
        S.cleanupTimer = setTimeout(() => {
          S.cleanupTimer = null;
          S.busy = new Set();
          S.awakeSince = null;
          killHelper(S, 'cleanup-grace');
          log('cleanup complete (grace expired)');
        }, 30000);
        if (S.cleanupTimer.unref) S.cleanupTimer.unref();
        log('unloaded with sessions busy; will release in 30s if not reloaded');
      } else {
        S.busy = new Set();
        S.awakeSince = null;
        killHelper(S, 'cleanup');
        log('cleanup complete');
      }
    };
  } catch (err) {
    // Fail-safe: a plugin error must never break OpenCode startup.
    warn('setup failed; staying inactive:', err && err.message ? err.message : err);
    return;
  }
}

export default {
  id: 'keep-awake',
  setup,
};
