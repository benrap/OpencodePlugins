/**
 * prefill — OpenCode V2 plugin (globally installed)
 *
 * Per-message opt-in message injection: when the user ends a message with the
 * marker `#prefill`, the plugin injects extra messages into the outgoing model
 * request (assistant prefill / conversation steering). The marker is a control
 * channel: it is stripped from the user's message at admission so the model
 * never sees it and it never appears in the persisted transcript.
 *
 * Prefill is OFF by default. No marker ⇒ no injection.
 *
 * Dependency-free plain-object plugin: `export default { id, setup }`.
 *
 * HOW IT WORKS
 *   1. `ctx.session.hook("prompt", (event) => ...)` intercepts the user's
 *      message at admission. `event.prompt.text` is mutable and "edits become
 *      the canonical persisted user input". If the text ends with `#prefill`
 *      (tolerating trailing whitespace/newlines) the marker is removed and a
 *      per-session "prefill armed for this turn" flag is set. If the marker is
 *      absent the flag is cleared, so it resets on every new message.
 *   2. `ctx.session.hook("context", (event) => ...)` runs immediately before
 *      model dispatch, before protocol lowering. When the session is armed it
 *      appends messages to `event.messages` in place. The `context` hook fires
 *      per model call (including tool round-trips); the armed flag persists for
 *      the whole turn and is cleared by the next prompt admission.
 *
 * MARKER RULES (decided + documented)
 *   - Matching is CASE-SENSITIVE: only the exact lowercase `#prefill`.
 *     Rationale: it is a deliberate control channel; case-insensitive matching
 *     would make accidental triggers (e.g. prose, code) more likely.
 *   - The marker must be at the END of the message, optionally followed only by
 *     whitespace/newlines (`/#prefill\s*$/`). `#prefill` mid-message never
 *     triggers.
 *   - A message that is ONLY the marker (or whitespace + marker) is NOT
 *     stripped and does NOT arm: stripping would leave an empty user message,
 *     which is an invalid/degenerate turn. The marker is left in place and the
 *     turn is treated as ordinary text. (Documented edge case.)
 *   - The marker is removed together with any whitespace it leaves at the end,
 *     e.g. `"do the thing #prefill\n"` ⇒ `"do the thing"`.
 *   - Idempotency: admission is not an exactly-once boundary (concurrent
 *     submissions may run the hook more than once; only the first successful
 *     admission wins). Re-admission of the already-stripped text is recognised
 *     by comparing against the stored canonical text, so a repeat run does not
 *     clear the armed flag.
 *
 * MODES (config `mode`)
 *   "assistant-prefill" — append ONE assistant message containing `seed`.
 *   "steer-pair"        — append an assistant message (seed) THEN a user message
 *                         (userSeed), i.e. a fabricated two-message exchange.
 *
 * CONFIG (ctx.options, all optional — zero config works):
 *   {
 *     "enabled":     true,               // master switch
 *     "mode":        "assistant-prefill",// or "steer-pair"
 *     "seed":        "<assistant text>", // THE one value you change to try things
 *     "userSeed":    "<user text>",      // steer-pair only
 *     "debug":       false,              // append a trace to the debug file
 *     "captureHttp": false               // capture the raw outgoing request body
 *   }
 *
 * ENV OVERRIDES (handy for `opencode run` experiments):
 *   PREFILL_SEED, PREFILL_MODE, PREFILL_USER_SEED, PREFILL_DISABLED=1,
 *   PREFILL_DEBUG=1, PREFILL_CAPTURE_HTTP=1, PREFILL_DEBUG_FILE=<path>.
 *   Back-compat: the lab names PREFILL_LAB_SEED / _MODE / _USER_SEED /
 *   _DISABLED / _CAPTURE_HTTP / _DEBUG_FILE are also accepted.
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
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAG = '[prefill]';
const SENTINEL = path.join(__dirname, 'prefill.debug');

/**
 * Trailing marker, case-sensitive, tolerating trailing whitespace/newlines.
 * `$` (no `m` flag) is end-of-input, so the marker must be at the very end.
 */
const MARKER_RE = /#prefill\s*$/;

const DEFAULTS = {
  enabled: true,
  mode: 'assistant-prefill',
  // PLACEHOLDER DEFAULT — the real wording is still to come from the user.
  // Keep the seed natural: text that self-identifies as an "injected directive"
  // makes alignment-trained models flag it and refuse instead of continuing.
  seed: '[PREFILL PLACEHOLDER — set options.seed or PREFILL_SEED] Understood — I will continue the conversation naturally from here.',
  userSeed: '[PREFILL PLACEHOLDER — set options.userSeed or PREFILL_USER_SEED] Please continue.',
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
      sessions: new Map(), // sessionID -> { armed: boolean, canonical: string|null }
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
    st = { armed: false, canonical: null };
    S.sessions.set(key, st);
  }
  return st;
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

// ---------------------------------------------------------------------------
// prompt hook — opt-in detection + marker stripping
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

  const m = MARKER_RE.exec(original);
  if (m) {
    const stripped = original.slice(0, m.index).replace(/\s+$/, '');
    if (!stripped.trim()) {
      // Marker-only message: stripping would empty it. Leave the text as-is and
      // do not arm (documented edge case).
      const st = sessionState(S, sessionID);
      st.armed = false;
      st.canonical = null;
      dbg(cfg, `prompt: marker-only message (len=${original.length}); not stripping, not arming session=${sessionID}`);
      return;
    }
    holder.text = stripped;
    const st = sessionState(S, sessionID);
    st.armed = true;
    st.canonical = stripped;
    dbg(
      cfg,
      `prompt: marker found; stripped len ${original.length}->${stripped.length}; ARMED session=${sessionID} canonical=${JSON.stringify(
        stripped,
      )}`,
    );
    return;
  }

  // No marker. Idempotency: if this is a re-admission of the text we just
  // stripped, keep the flag as it was (do not disarm).
  const st = sessionState(S, sessionID);
  if (st.armed && st.canonical != null && original === st.canonical) {
    dbg(cfg, `prompt: re-admission of already-stripped text; keeping ARMED session=${sessionID}`);
    return;
  }

  st.armed = false;
  st.canonical = null;
  dbg(cfg, `prompt: no marker; disarmed session=${sessionID}`);
}

// ---------------------------------------------------------------------------
// context hook — injection
// ---------------------------------------------------------------------------

function applyInjection(cfg, S, event) {
  const messages = event && event.messages;
  if (!Array.isArray(messages)) {
    dbg(cfg, 'context: event.messages is not an array; no-op');
    return;
  }

  if (cfg.debug) {
    const eventKeys = event && typeof event === 'object' ? Object.keys(event) : [];
    dbg(cfg, `context fired: eventKeys=[${eventKeys.join(',')}] messages.length=${messages.length}`);
    const tail = messages.slice(-4);
    tail.forEach((msg, i) => {
      dbg(cfg, `  msg[-${tail.length - i}] ${describeMessage(msg)} :: ${previewOf(msg)}`);
    });
  }

  const last = messages[messages.length - 1];
  const lastRole = roleOf(last);
  const lastText = contentToText(last && last.content).trim();

  const seed = String(cfg.seed ?? '');
  const userSeed = String(cfg.userSeed ?? '');
  const thinkingSeed = String(cfg.thinkingSeed ?? '');

  // Double-injection guard: if the trailing message is already ours, do nothing.
  if (lastRole === 'assistant' && lastText === seed.trim()) {
    dbg(cfg, 'skip: trailing assistant message is already the injected seed');
    return;
  }
  if (
    lastRole === 'user' &&
    (cfg.mode === 'steer-pair' ||
      cfg.mode === 'reasoning-continue' ||
      cfg.mode === 'think-reply-continue') &&
    lastText === userSeed.trim()
  ) {
    dbg(cfg, 'skip: trailing user message is already the injected steer message');
    return;
  }

  // Only inject when the last message is a user turn. This also means tool
  // round-trips (trailing role "tool") never re-inject within a turn.
  if (lastRole !== 'user') {
    dbg(cfg, `skip: trailing role is ${JSON.stringify(lastRole)}, not "user"`);
    return;
  }

  if (!seed.trim()) {
    dbg(cfg, 'skip: seed is empty (OpenAIChat would drop an empty assistant turn)');
    return;
  }

  const sample = messages[messages.length - 1];
  const useParts = Array.isArray(sample && sample.content);

  // --- which parts does this mode inject? ---------------------------------
  // OpenAIChat.lowerAssistantMessage lowers `reasoning` parts into the model's
  // `compatibility.reasoningField` (e.g. `reasoning_content`) and `text` parts
  // into `content`. Verified at the wire level. So ONE assistant message can
  // carry BOTH: reasoning is invisible to the reply, text is the reply prefix.
  const THINK_REPLY = 'think-reply-continue';
  const modesWithUserTurn =
    cfg.mode === 'steer-pair' || cfg.mode === 'reasoning-continue' || cfg.mode === THINK_REPLY;
  const asReasoning =
    cfg.mode === 'reasoning' || cfg.mode === 'reasoning-continue' || cfg.mode === THINK_REPLY;

  const injected = [];
  if (cfg.mode === THINK_REPLY) {
    if (thinkingSeed) injected.push({ type: 'reasoning', text: thinkingSeed });
    if (seed) injected.push({ type: 'text', text: seed });
  } else if (asReasoning) {
    injected.push({ type: 'reasoning', text: seed });
  } else {
    injected.push({ type: 'text', text: seed });
  }

  messages.push({
    role: 'assistant',
    content: useParts ? injected : injected.map((p) => p.text).join(''),
  });
  S.injections++;
  dbg(
    cfg,
    `INJECTED assistant message (mode=${cfg.mode}) parts=[${injected
      .map((p) => p.type)
      .join(',')}] thinkingLen=${thinkingSeed.length} textLen=${seed.length}`,
  );

  // Trailing user turn. An injected ASSISTANT turn leaves the array ending on an
  // assistant message, which the model can treat as "I have already finished"
  // and answer with end-of-sequence. A user turn gives it something to respond
  // to, and makes the array end on `user` (which every provider accepts).
  if (modesWithUserTurn && userSeed.trim()) {
    messages.push(makeMessage('user', userSeed, sample));
    dbg(cfg, `INJECTED user message len=${userSeed.length}`);
  }
}

function onContext(cfg, S, event) {
  const sessionID = sessionIdOf(event);
  const st = S.sessions.get(sessionID);
  if (!st || !st.armed) {
    dbg(cfg, `context: session=${sessionID} not armed; no injection`);
    return;
  }
  dbg(cfg, `context: session=${sessionID} ARMED; injecting`);
  applyInjection(cfg, S, event);
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

  const modeRaw = firstString(options.mode, env.PREFILL_MODE, env.PREFILL_LAB_MODE);

  let captureSeq = 0;
  const captureDir = firstString(env.PREFILL_CAPTURE_DIR) || (debugFile ? path.dirname(debugFile) : __dirname);

  return {
    enabled:
      options.enabled !== false &&
      env.PREFILL_DISABLED !== '1' &&
      env.PREFILL_LAB_DISABLED !== '1',
    mode:
      modeRaw === 'steer-pair'
        ? 'steer-pair'
        : modeRaw === 'reasoning'
          ? 'reasoning'
          : modeRaw === 'reasoning-continue'
            ? 'reasoning-continue'
            : modeRaw === 'think-reply-continue'
              ? 'think-reply-continue'
              : 'assistant-prefill',
    seed: firstString(options.seed, env.PREFILL_SEED, env.PREFILL_LAB_SEED) || DEFAULTS.seed,
    userSeed:
      firstString(options.userSeed, env.PREFILL_USER_SEED, env.PREFILL_LAB_USER_SEED) ||
      DEFAULTS.userSeed,
    debug,
    debugFile,
    captureHttp: options.captureHttp === true || env.PREFILL_CAPTURE_HTTP === '1',
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
    // options -- which is exactly how `mode: "reasoning"` silently failed to
    // take effect in a running service.
    S.cfg = readConfig(ctx);
    const cfg = S.cfg;

    dbg(
      cfg,
      `SETUP pid=${process.pid} refs=${S.setupRefs} mode=${cfg.mode} enabled=${cfg.enabled} captureHttp=${cfg.captureHttp} options=${JSON.stringify(
        (ctx && ctx.options) || {},
      )}`,
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

    // Register the `prompt` hook (opt-in detection + marker stripping).
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

    // Register the `context` hook (injection). Re-registered on EVERY setup().
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
