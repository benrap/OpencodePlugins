/**
 * always-background — OpenCode V2 plugin (ACTIVE ENFORCEMENT)
 *
 * ✅  ACTIVE. Registered via opencode.jsonc and loaded from this index.js
 *     (package.json `main`). The Step-0 logging-only probe is preserved for
 *     provenance as index.probe.js (not loaded).
 *
 * Purpose: force `background: true` on every tool call EXCEPT `shell` and
 * `subagent` (which have their own `background` input the user controls
 * explicitly). This prevents tools like `read`, `edit`, `subagent-status`, etc.
 * from blocking the session. The exclude list is configurable via the plugin
 * option `exclude` (defaults to `['shell', 'subagent']`).
 *
 * ---------------------------------------------------------------------------
 * MECHANISM (empirically proven on opencode v2.0.6, see probe.log):
 *   await ctx.tool.hook('execute.before', (event) => { ... })
 *   - The callback receives a mutable event object with the shape:
 *       { tool: string, sessionID, agent, messageID, id, input: object }
 *   - `event.tool` is the tool name ("shell", "subagent", ...).
 *   - `event.input` is the tool's input object:
 *       shell:    { command, [workdir], [timeout], [background] }
 *       subagent: { agent, description, prompt, [background] }
 *   - Forcing background is done by MUTATING IN PLACE:
 *       event.input.background = true;
 *     A RETURNED replacement is IGNORED (proven: returning
 *     { ...event, input: { ...event.input, background: true } } had no effect).
 *
 * REGISTRATION LIFECYCLE (important, empirically derived):
 *   - Re-register on EVERY setup(). The host drops a plugin generation's
 *     registrations when that generation is replaced, so a permanent
 *     "register once" guard silently disables the hook after any reload.
 *   - Do NOT call the returned Registration.dispose(). Disposing the previous
 *     registration removes the live hook (async delete keyed by
 *     pluginId+hookName), leaving enforcement dead.
 *   - The host dedupes by (pluginId, hookName): repeated hook() calls yield
 *     exactly one live hook (observed: one execute.before per tool call).
 *
 * SINGLETON: a globalThis Symbol-keyed state object (mirrors keep-awake) so
 * repeated setup() calls share counters/state; total fail-safe try/catch so a
 * plugin error can never break host startup or the request pipeline.
 *
 * DEBUG LOGGING (default OFF, cheap, live-toggleable):
 *   - enabled when env ALWAYS_BACKGROUND_DEBUG_FILE points at a file, OR
 *   - enabled when a file named `always-background.debug` exists next to this
 *     index.js (so it can be switched on in the running service without
 *     a restart).
 *   Existence is re-checked at most once per DEBUG_TTL_MS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATE_KEY = Symbol.for('opencode.always-background.state.v2');
const DEBUG_SENTINEL = path.join(__dirname, 'always-background.debug');
const DEBUG_TTL_MS = 2000;

function envDebugFile() {
  try { return process.env.ALWAYS_BACKGROUND_DEBUG_FILE || null; } catch { return null; }
}

function getState() {
  let s = globalThis[STATE_KEY];
  if (!s) {
    s = {
      setupRefs: 0,
      registrations: 0,
      enforced: 0,
      warnedNoHook: false,
      registration: null,
      registering: false,
      registeringSince: 0,
      debugCache: { at: 0, target: undefined },
      exclude: ['shell', 'subagent'],
    };
    globalThis[STATE_KEY] = s;
  }
  return s;
}

function debugTarget(S) {
  const env = envDebugFile();
  if (env) return env;
  const now = Date.now();
  const cache = S.debugCache;
  if (cache.target !== undefined && now - cache.at < DEBUG_TTL_MS) return cache.target;
  let target = null;
  try { if (fs.existsSync(DEBUG_SENTINEL)) target = DEBUG_SENTINEL; } catch { /* ignore */ }
  S.debugCache = { at: now, target };
  return target;
}

function dbg(S, msg) {
  try {
    const target = debugTarget(S);
    if (!target) return;
    fs.appendFileSync(target, `${new Date().toISOString()} [always-background] ${msg}\n`);
  } catch { /* logging must never throw into the host */ }
}

function enforce(event, S) {
  try {
    if (!event || typeof event !== 'object') return;
    const tool = event.tool;
    const exclude = Array.isArray(S.exclude) ? S.exclude : ['shell', 'subagent'];
    if (exclude.includes(tool)) return;
    const input = event.input;
    if (!input || typeof input !== 'object') return;
    input.background = true; // in-place mutation is the proven mechanism
    S.enforced++;
    if (S.enforced <= 5 || S.enforced % 100 === 0) {
      dbg(S, `enforced background on ${tool} (count=${S.enforced})`);
    }
  } catch (err) {
    try { dbg(S, `enforce failed: ${err && err.stack ? err.stack : String(err)}`); } catch { /* ignore */ }
  }
}

async function setup(ctx) {
  try {
    const S = getState();
    S.setupRefs++;

    // Read the exclude list from plugin options (ctx.options or ctx.config).
    // Defaults to ['shell', 'subagent'] — the tools that have their own
    // `background` input the user controls explicitly.
    const rawOptions = (ctx && (ctx.options || ctx.config)) || {};
    const rawExclude = rawOptions.exclude;
    if (Array.isArray(rawExclude) && rawExclude.length > 0) {
      S.exclude = rawExclude.filter((t) => typeof t === 'string');
    } else {
      S.exclude = ['shell', 'subagent'];
    }

    if (!ctx || !ctx.tool || typeof ctx.tool.hook !== 'function') {
      if (!S.warnedNoHook) {
        S.warnedNoHook = true;
        dbg(S, 'ctx.tool.hook unavailable; enforcement disabled (no-op)');
        try { console.warn('[always-background] ctx.tool.hook unavailable; enforcement disabled (no-op)'); } catch { /* ignore */ }
      }
      return;
    }

    // Guard only against overlapping registrations; intentionally do NOT
    // permanently suppress registration (see lifecycle note above). A stale
    // in-flight flag (hook() never settled) must not wedge enforcement, so
    // proceed with re-registration if it has been set for longer than
    // REGISTERING_STALE_MS.
    const REGISTERING_STALE_MS = 5000;
    const now = Date.now();
    if (S.registering && now - S.registeringSince < REGISTERING_STALE_MS) {
      dbg(S, 'registration already in flight; skipping');
      return;
    }
    if (S.registering) {
      dbg(S, `registration in flight for ${now - S.registeringSince}ms (>= ${REGISTERING_STALE_MS}ms stale); proceeding to re-register`);
    }
    S.registering = true;
    S.registeringSince = now;
    try {
      S.registrations++;
      const reg = S.registrations;
      S.registration = await ctx.tool.hook('execute.before', (event) => enforce(event, S));
      dbg(S, `registered execute.before (registration=${reg}, setupRefs=${S.setupRefs})`);
    } catch (err) {
      dbg(S, `registration threw: ${err && err.stack ? err.stack : String(err)}`);
    } finally {
      S.registering = false;
    }
  } catch (err) {
    // Fail-safe: a plugin error must never break OpenCode startup.
    try { dbg(getState(), `setup failed: ${err && err.stack ? err.stack : String(err)}`); } catch { /* ignore */ }
    return;
  }
}

export default {
  id: 'always-background',
  setup,
};
