/**
 * prefill — OpenCode V2 plugin (globally installed)
 *
 * Per-message opt-in message injection driven by a literal separator marker.
 * A message may embed the case-sensitive marker `#prefill` once or twice to
 * split the input into parts; the first part is persisted as the user's message
 * and the remaining parts are appended to the outgoing model request as an
 * alternating assistant/user exchange (conversation steering / prefill).
 *
 *   message1 #prefill message2 #prefill message3
 *     => parts [message1, message2, message3]
 *     => persisted user message: "message1"
 *     => request gains: assistant "message2", then user "message3"
 *     => model sees [user: message1, assistant: message2, user: message3]
 *
 * No marker => nothing happens. Prefill is OFF by default in that sense: it is
 * strictly opt-in per message.
 *
 * Dependency-free plain-object plugin: `export default { id, setup }`.
 *
 * HOW IT WORKS
 *   1. `ctx.session.hook("prompt", (event) => ...)` intercepts the user's
 *      message at admission. `event.prompt.text` is mutable and "edits become
 *      the canonical persisted user input". If the text contains `#prefill` it
 *      is split on that literal separator; the mutable text is rewritten to the
 *      FIRST non-empty part and the remaining parts are stashed per session. If
 *      the marker is absent the session is disarmed, so state resets on every
 *      new message.
 *   2. `ctx.session.hook("context", (event) => ...)` runs immediately before
 *      model dispatch, before protocol lowering. When the session is armed it
 *      appends the stashed parts to `event.messages` in order as alternating
 *      assistant/user messages. The `context` hook fires per model call
 *      (including tool round-trips); a per-turn `injected` flag ensures we only
 *      inject once, and it is reset by the next prompt admission.
 *
 * ROLE / SEPARATOR RULES (decided + documented)
 *   - The separator is the literal, CASE-SENSITIVE string `#prefill`. Split on
 *     it, trim each part, and drop empties:
 *       text.split('#prefill').map(s => s.trim()).filter(s => s.length > 0)
 *   - Roles alternate starting with the user:
 *       p1=user (persisted), p2=assistant, p3=user, p4=assistant, ...
 *   - The FIRST part is the persisted user message; everything from the first
 *     marker onward is stripped from the persisted transcript.
 *   - The remaining parts (p2..pn) are REQUEST-ONLY: they are appended to the
 *     model request via the `context` hook and are NOT persisted. This is the
 *     accepted trade-off of using a single user message as the carrier.
 *   - The request must end on a user-role part so the model replies. If the
 *     remaining parts end on an assistant part (an odd number of remaining
 *     parts, i.e. an even total number of parts), a trailing user nudge is
 *     appended (`trailingNudge`, default "Continue").
 *   - A message with NO marker is a clean no-op: no rewrite, no injection.
 *   - A message that is ONLY the marker(s) (e.g. `#prefill` or
 *     `#prefill #prefill`, optionally surrounded by whitespace) is a no-op: the
 *     text is left untouched and the session is not armed.
 *   - A trailing marker with a single non-empty part (e.g. `message1 #prefill`)
 *     persists `message1` but injects nothing (there is nothing to inject).
 *   - Idempotency: admission is not an exactly-once boundary (concurrent
 *     submissions may run the hook more than once). Re-admission of the
 *     already-rewritten text (which has no marker) is recognised by comparing
 *     against the stored canonical text, so a repeat run does not clear the
 *     armed/injectable state.
 *
 * CONFIG (ctx.options, all optional — zero config works):
 *   {
 *     "enabled":       true,        // master switch
 *     "trailingNudge": "Continue",  // user turn appended when the parts end on assistant
 *     "debug":         false,       // append a trace to the debug file
 *     "captureHttp":   false        // capture the raw outgoing request body
 *   }
 *
 * ENV OVERRIDES (handy for `opencode run` experiments):
 *   PREFILL_TRAILING_NUDGE, PREFILL_DISABLED=1, PREFILL_DEBUG=1,
 *   PREFILL_CAPTURE_HTTP=1, PREFILL_DEBUG_FILE=<path>.
 *   Back-compat: the lab names PREFILL_LAB_DISABLED, PREFILL_LAB_DEBUG_FILE and
 *   PREFILL_LAB_CAPTURE_HTTP are also accepted.
 *
 * DEBUG LOGGING (default OFF):
 *   Enabled when env PREFILL_DEBUG_FILE points at a file, when options.debug is
 *   true, when env PREFILL_DEBUG=1, or when a file named `prefill.debug` exists
 *   next to this index.js (a live toggle for the running service).
 *
 * LIFECYCLE NOTES (learned the hard way — do not "optimise" these away):
 *   - We re-register BOTH hooks on EVERY setup(). A register-once guard silently
 *     disables the hook because V2 re-evaluates plugins per reconciliation.
 *   - We never call dispose().
 *   - We mutate the event in place; returned replacements are ignored.
 *   - Everything is wrapped in try/catch so a plugin error can never break
 *     startup or a model turn. Missing hooks are a clean no-op.
 *   - Per-session state lives on globalThis keyed by
 *     Symbol.for('opencode.prefill.state.v1') because the module may be
 *     re-evaluated per reconciliation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAG = '[prefill]';
const SENTINEL = path.join(__dirname, 'prefill.debug');

/** The literal, case-sensitive separator marker. */
const MARKER = '#prefill';

const DEFAULTS = {
  enabled: true,
  trailingNudge: 'Continue',
  debug: false,
  captureHttp: false,
};

// ---------------------------------------------------------------------------
// Process-wide singleton state. OpenCode may re-evaluate this module per
// setup() invocation, so state must live on globalThis (shared by all module
// instances in the same realm) rather than in module-level variables.
// ---------------------------------------------------------------------------
const STATE_KEY = Symbol.for('opencode.prefill.state.v1');

function getState() {
  let s = globalThis[STATE_KEY];
  if (!s) {
    s = {
      setupRefs: 0,
      // Live config, refreshed on every setup(). Hooks read THIS at fire time
      // rather than closing over a setup-time snapshot, so a hook registration
      // that survives a reconciliation cannot keep using stale options.
      cfg: null,
      // sessionID -> { armed, parts, canonical, injected }
      sessions: new Map(),
      prompts: 0,
      injections: 0,
    };
    globalThis[STATE_KEY] = s;
  }
  return s;
}

function sessionState(S, sessionID) {
  const key = sessionID || 'unknown';
  let st = S.sessions.get(key);
  if (!st) {
    st = newSessionState();
    S.sessions.set(key, st);
  }
  return st;
}

function newSessionState() {
  return { armed: false, parts: [], canonical: null, injected: false };
}

function resetSessionState(st) {
  st.armed = false;
  st.parts = [];
  st.canonical = null;
  st.injected = false;
}

// ---------------------------------------------------------------------------
// Logging (never throws into the host)
// ---------------------------------------------------------------------------
function debugFile(cfg) {
  return cfg && cfg.debugFile ? cfg.debugFile : null;
}

function dbg(cfg, msg) {
  const file = debugFile(cfg);
  if (!file) return;
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${TAG} ${msg}\n`);
  } catch {
    /* never break the host */
  }
}

function log(...args) {
  try {
    console.log(TAG, ...args);
  } catch {
    /* ignore */
  }
}
function warn(...args) {
  try {
    console.error(TAG, ...args);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Message helpers (ported from prefill-lab)
// ---------------------------------------------------------------------------

/** Content is either a plain string or an array of content parts. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
        }
        return '';
      })
      .join('');
  }
  if (content == null) return '';
  return String(content);
}

/** Build a message that mirrors the content encoding already in use. */
function makeMessage(role, text, sample) {
  const useParts = Array.isArray(sample && sample.content);
  const content = useParts ? [{ type: 'text', text }] : text;
  return { role, content };
}

function roleOf(m) {
  return m && typeof m === 'object' ? m.role : undefined;
}

/** Describe the shape of an assembled message for diagnostics. */
function describeMessage(m) {
  if (m == null) return '<null>';
  if (typeof m !== 'object') return `<${typeof m}>`;
  const keys = Object.keys(m);
  const c = m.content;
  let enc;
  if (typeof c === 'string') enc = `string(len=${c.length})`;
  else if (Array.isArray(c)) {
    enc = `array(len=${c.length}, partTypes=[${c
      .map((p) => (p && typeof p === 'object' ? p.type || '?' : typeof p))
      .join(',')}])`;
  } else enc = c == null ? 'null/undefined' : typeof c;
  return `{keys=[${keys.join(',')}] role=${JSON.stringify(m.role)} content=${enc}}`;
}

/** Compact one-line preview of a message's text. */
function previewOf(m) {
  const t = contentToText(m && m.content).replace(/\s+/g, ' ').trim();
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}

/** Extract the session id from either hook's event, defensively. */
function sessionIdOf(event) {
  if (!event || typeof event !== 'object') return 'unknown';
  if (typeof event.sessionID === 'string') return event.sessionID;
  if (event.prompt && typeof event.prompt.sessionID === 'string') return event.prompt.sessionID;
  if (event.data && typeof event.data.sessionID === 'string') return event.data.sessionID;
  return 'unknown';
}

/** Split admitted text on the literal marker; trim parts and drop empties. */
function splitParts(text) {
  return String(text)
    .split(MARKER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// prompt hook — marker detection + part extraction + persisted rewrite
// ---------------------------------------------------------------------------

/**
 * Locate the mutable prompt text on the admission event.
 * Primary contract: `event.prompt.text`. We also accept `event.text` as a
 * defensive fallback so a minor shape change degrades instead of failing.
 */
function promptHolder(event) {
  if (!event || typeof event !== 'object') return null;
  const p = event.prompt;
  if (p && typeof p === 'object' && typeof p.text === 'string') return p;
  if (typeof p === 'string') return event; // event.prompt as a bare string
  if (typeof event.text === 'string') return event;
  return null;
}

function onPrompt(cfg, S, event) {
  const holder = promptHolder(event);
  if (!holder) {
    dbg(
      cfg,
      `prompt fired but no mutable text found; eventKeys=[${
        event && typeof event === 'object' ? Object.keys(event).join(',') : typeof event
      }]`,
    );
    return;
  }

  const sessionID = sessionIdOf(event);
  const original = holder.text;
  S.prompts++;

  const hasMarker = typeof original === 'string' && original.includes(MARKER);
  const st = sessionState(S, sessionID);

  // No marker: a clean no-op for a fresh message. The one exception is
  // idempotent re-admission of the text we just rewrote (which has no marker):
  // keep the armed/injectable state instead of clearing it.
  if (!hasMarker) {
    if (st.armed && st.canonical != null && original === st.canonical) {
      dbg(cfg, `prompt: re-admission of already-rewritten text; keeping ARMED session=${sessionID}`);
      return;
    }
    resetSessionState(st);
    dbg(cfg, `prompt: no marker; disarmed session=${sessionID}`);
    return;
  }

  const parts = splitParts(original);

  // Marker-only message (e.g. "#prefill", "#prefill #prefill", whitespace
  // only): stripping would leave an empty persisted message, which is invalid.
  // Leave the text untouched and reset state (documented edge case).
  if (parts.length === 0) {
    resetSessionState(st);
    dbg(
      cfg,
      `prompt: marker-only message (len=${original.length}); not rewriting, not arming session=${sessionID}`,
    );
    return;
  }

  const persisted = parts[0];
  const rest = parts.slice(1);

  // Rewrite the mutable persisted text: strip the markers and everything after
  // the first one. The remaining parts are request-only.
  holder.text = persisted;
  st.canonical = persisted;
  st.parts = rest;
  st.armed = rest.length > 0; // only arm when there is something to inject
  st.injected = false; // new admitted turn: allow injection again

  dbg(
    cfg,
    `prompt: marker found; parts=${parts.length} rest=${rest.length}; persisted len ${original.length}->${persisted.length}; ` +
      `${st.armed ? 'ARMED' : 'not-armed (nothing to inject)'} session=${sessionID} canonical=${JSON.stringify(persisted)}`,
  );
}

// ---------------------------------------------------------------------------
// context hook — request-only injection
// ---------------------------------------------------------------------------

function applyInjection(cfg, S, event, st) {
  const messages = event && event.messages;
  if (!Array.isArray(messages)) {
    dbg(cfg, 'context: event.messages is not an array; no-op');
    return false;
  }

  if (cfg.debug) {
    const eventKeys = event && typeof event === 'object' ? Object.keys(event) : [];
    dbg(cfg, `context fired: eventKeys=[${eventKeys.join(',')}] messages.length=${messages.length}`);
    const tail = messages.slice(-4);
    tail.forEach((msg, i) => {
      dbg(cfg, `  msg[-${tail.length - i}] ${describeMessage(msg)} :: ${previewOf(msg)}`);
    });
  }

  const rest = Array.isArray(st.parts) ? st.parts.slice() : [];
  if (rest.length === 0) {
    dbg(cfg, 'context: armed but no parts to inject; no-op');
    return false;
  }

  const sample = messages.length > 0 ? messages[messages.length - 1] : null;

  // p2 = assistant, p3 = user, p4 = assistant, ... (index 0 is p2).
  rest.forEach((text, i) => {
    const role = i % 2 === 0 ? 'assistant' : 'user';
    messages.push(makeMessage(role, text, sample));
    dbg(cfg, `INJECTED ${role} message len=${text.length} :: ${JSON.stringify(text)}`);
  });

  // The request must end on a user-role part so the model replies. If the last
  // injected part is an assistant part, append a trailing user nudge.
  const lastInjectedRole = (rest.length - 1) % 2 === 0 ? 'assistant' : 'user';
  if (lastInjectedRole !== 'user') {
    const nudge = String(cfg.trailingNudge ?? '').trim();
    if (nudge) {
      messages.push(makeMessage('user', cfg.trailingNudge, sample));
      dbg(cfg, `INJECTED trailing user nudge len=${cfg.trailingNudge.length}`);
    } else {
      dbg(cfg, 'WARNING: parts end on assistant and trailingNudge is empty; request may not elicit a reply');
    }
  }

  S.injections++;
  dbg(cfg, `context: injection complete (${rest.length} part(s)) session armed -> ${S.injections} total`);
  return true;
}

function onContext(cfg, S, event) {
  const sessionID = sessionIdOf(event);
  const st = S.sessions.get(sessionID);
  if (!st || !st.armed) {
    dbg(cfg, `context: session=${sessionID} not armed; no injection`);
    return;
  }
  // Double-injection guard: the context hook can fire multiple times per turn
  // (including tool round-trips). Inject only once per admitted turn.
  if (st.injected) {
    dbg(cfg, `context: session=${sessionID} already injected this turn; skipping`);
    return;
  }
  dbg(cfg, `context: session=${sessionID} ARMED; injecting`);
  const didInject = applyInjection(cfg, S, event, st);
  if (didInject) st.injected = true;
}

// ---------------------------------------------------------------------------
// Optional raw HTTP body capture (ported from prefill-lab)
// ---------------------------------------------------------------------------

/**
 * CRITICAL: never consume or lock the real request body. The only safe read is
 * `request.clone().text()` on a Fetch Request/Response. Reading the live stream
 * throws "Body is disturbed or locked" and kills the model call.
 */
async function captureHttpBody(cfg, event) {
  try {
    const cloneable = event && event.request;
    if (!cloneable || typeof cloneable.clone !== 'function' || typeof cloneable.text !== 'function') {
      dbg(cfg, 'http.request fired but no cloneable event.request; NOT reading');
      return;
    }
    const clone = cloneable.clone();
    const text = await clone.text();
    let headers = {};
    try {
      headers = cloneable.headers ? Object.fromEntries(cloneable.headers) : {};
    } catch {
      headers = {};
    }
    const safeHeaders = { ...headers };
    for (const k of Object.keys(safeHeaders)) {
      if (/authorization|api[-_]?key|cookie/i.test(k)) safeHeaders[k] = '<redacted>';
    }
    const file = cfg.captureFile(text);
    dbg(
      cfg,
      `http.request captured len=${text.length} url=${cloneable.url || '?'} headers=${JSON.stringify(
        safeHeaders,
      )} -> ${file}`,
    );
  } catch (err) {
    dbg(cfg, `http.request capture failed (swallowed): ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function readConfig(ctx) {
  const options = (ctx && ctx.options) || {};
  const env = process.env || {};
  const firstString = (...vals) => vals.find((v) => typeof v === 'string' && v.length > 0);

  const envDebugFile = firstString(env.PREFILL_DEBUG_FILE, env.PREFILL_LAB_DEBUG_FILE);
  let sentinelExists = false;
  try {
    sentinelExists = fs.existsSync(SENTINEL);
  } catch {
    sentinelExists = false;
  }
  const debugFile = envDebugFile || (sentinelExists ? SENTINEL : null);
  const debug = options.debug === true || env.PREFILL_DEBUG === '1' || debugFile != null;

  let captureSeq = 0;
  const captureDir = firstString(env.PREFILL_CAPTURE_DIR) || (debugFile ? path.dirname(debugFile) : __dirname);

  return {
    enabled:
      options.enabled !== false &&
      env.PREFILL_DISABLED !== '1' &&
      env.PREFILL_LAB_DISABLED !== '1',
    trailingNudge:
      firstString(options.trailingNudge, env.PREFILL_TRAILING_NUDGE) || DEFAULTS.trailingNudge,
    debug,
    debugFile,
    captureHttp: options.captureHttp === true || env.PREFILL_CAPTURE_HTTP === '1' || env.PREFILL_LAB_CAPTURE_HTTP === '1',
    captureFile(text) {
      captureSeq += 1;
      const file = path.join(captureDir, `prefill-request-${captureSeq}.json`);
      try {
        fs.writeFileSync(file, text);
      } catch {
        /* ignore */
      }
      return file;
    },
  };
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function setup(ctx) {
  try {
    const S = getState();
    S.setupRefs++;
    // Refresh the SHARED config on every setup(); the hooks read it at fire
    // time (see the hook registrations below). V2 re-runs setup() on
    // reconciliation but does not necessarily dispose prior hook registrations,
    // so a hook closing over a setup-time snapshot would keep using STALE
    // options.
    S.cfg = readConfig(ctx);
    const cfg = S.cfg;

    dbg(
      cfg,
      `SETUP pid=${process.pid} refs=${S.setupRefs} enabled=${cfg.enabled} trailingNudge=${JSON.stringify(
        cfg.trailingNudge,
      )} captureHttp=${cfg.captureHttp} options=${JSON.stringify((ctx && ctx.options) || {})}`,
    );

    if (!cfg.enabled) {
      log('disabled via options.enabled=false');
      return; // no dispose
    }

    if (!ctx || !ctx.session || typeof ctx.session.hook !== 'function') {
      warn('ctx.session.hook unavailable; staying inactive (no-op)');
      dbg(cfg, 'ctx.session.hook unavailable; no-op');
      return; // no dispose
    }

    // Register the `prompt` hook (marker detection + persisted rewrite).
    // Re-registered on EVERY setup() — no register-once guard.
    try {
      await ctx.session.hook('prompt', (event) => {
        // Read the LIVE config, not the setup-time snapshot.
        const live = getState().cfg || cfg;
        try {
          onPrompt(live, S, event);
        } catch (err) {
          dbg(live, `prompt handler error (swallowed): ${err && err.message ? err.message : err}`);
        }
      });
      log('prompt hook registered');
      dbg(cfg, 'registered prompt hook');
    } catch (err) {
      warn('failed to register prompt hook:', err && err.message ? err.message : err);
      dbg(cfg, `failed to register prompt hook: ${err && err.message ? err.message : err}`);
    }

    // Register the `context` hook (request-only injection). Re-registered on
    // EVERY setup().
    try {
      await ctx.session.hook('context', (event) => {
        // Read the LIVE config, not the setup-time snapshot.
        const live = getState().cfg || cfg;
        try {
          onContext(live, S, event);
        } catch (err) {
          dbg(live, `context handler error (swallowed): ${err && err.message ? err.message : err}`);
        }
      });
      log('context hook registered');
      dbg(cfg, 'registered context hook');
    } catch (err) {
      warn('failed to register context hook:', err && err.message ? err.message : err);
      dbg(cfg, `failed to register context hook: ${err && err.message ? err.message : err}`);
    }

    // Optional raw-body capture (opt-in; absence/failure must never matter).
    if (cfg.captureHttp) {
      try {
        await ctx.session.hook('http.request', (event) => {
          captureHttpBody(cfg, event).catch(() => {});
        });
        dbg(cfg, 'registered http.request hook');
      } catch (err) {
        dbg(cfg, `http.request hook unavailable: ${err && err.message ? err.message : err}`);
      }
    }

    return; // no dispose
  } catch (err) {
    // Fail-safe: never break OpenCode startup.
    warn('setup failed; staying inactive:', err && err.message ? err.message : err);
    try {
      dbg(getState(), `setup failed: ${err && err.stack ? err.stack : String(err)}`);
    } catch {
      /* ignore */
    }
    return;
  }
}

export default {
  id: 'prefill',
  setup,
};
