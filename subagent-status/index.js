/**
 * subagent-status — OpenCode V2 plugin
 *
 * Registers a `subagent-status` tool that lets a parent agent probe a subagent's
 * state WITHOUT pulling the subagent's raw transcript into its own context. The
 * tool reads the target session's recent conversation, asks an LLM to summarise
 * it, and returns ONLY the summary.
 *
 * Dependency-free plain object plugin: `export default { id, setup }`.
 *
 * ── API EVIDENCE (OpenCode v2.0.6, extracted from the runtime binary) ────────
 *
 *   - Tool registration (same pattern the built-in `question` tool uses):
 *       ctx.tool.transform((editor) => editor.add({ ... }))
 *     `add` accepts { name, description, options, input, execute }.
 *
 *   - LLM text generation — two mechanisms exist on the plugin context:
 *
 *       ctx.session.generate({ sessionID, prompt }) -> Promise<{ text: string }>
 *     Backed by SessionGenerate (POST /api/session/:sessionID/generate). It
 *     resolves the target session's own agent + model (SessionContext.select /
 *     resolveModel) and runs the request AS that real session. This is the
 *     "legal" path: it is attributed to a live session, so it works with the
 *     free tier, and it uses the SAME model as the session's agent by
 *     construction — the endpoint has no model parameter. It is therefore the
 *     default here. No direct HTTP call, no service password, no bypass.
 *
 *       ctx.generate.text(input) -> Promise<{ text: string }>
 *     where `input` is `{ prompt, model? }` (v2 has no `location` field).
 *     Backed by the `@opencode/Generate` service
 *     (POST /api/experimental/generate) — a STATELESS call. It stamps the
 *     request with a freshly created synthetic `x-opencode-session` id, so the
 *     OpenCode free tier rejects it with
 *     "OpenCode's free tier can only be used from within OpenCode".
 *     It is used ONLY for an explicit `model` override, or as a last-resort
 *     fallback (with the session's model read via `ctx.session.get`).
 *
 *   - Reading a session's model — `ctx.session.get({ sessionID })` returns the
 *     public Session.Info, whose optional `model` field is a Model.Ref
 *     `{ id, providerID, variant? }`.
 *
 *   - Reading a session's messages — v2.0.6's plugin context exposes:
 *       ctx.session.context({ sessionID }) -> Promise<SessionMessageInfo[]>
 *     i.e. the active context messages (everything after the last compaction),
 *     in chronological order. NOTE: v2.0.6 does NOT expose
 *     `ctx.session.messages({ sessionID, order, limit })` on the plugin context
 *     (that is the internal `Session.Service` method, not the plugin surface).
 *     We still try `ctx.session.messages` FIRST so a future runtime that adds it
 *     is used automatically, then fall back to `ctx.session.context`.
 *
 * Fail-safe: a plugin error must never break host startup, so `setup` is fully
 * wrapped and becomes a clean no-op when the expected context is unavailable.
 */

const TOOL_NAME = 'subagent-status';

const TOOL_DESCRIPTION =
  "Summarise a subagent session's current state without loading its raw " +
  'transcript into your context. Reads the target session\'s recent messages ' +
  'and returns an LLM-generated 2-4 sentence summary of what it is doing, its ' +
  'status (running/completed/failed/blocked), key findings and decisions, ' +
  'blockers, and the likely next step. Pass the subagent\'s sessionID (the id ' +
  'returned when it was spawned). Set mode to "state" for a lightweight ' +
  'status check (running/idle/waiting/finished) without an LLM call.';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    sessionID: {
      type: 'string',
      description: 'Session id of the subagent to summarise.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'How many recent messages to read. Defaults to 20.',
    },
    model: {
      type: 'string',
      description:
        'Optional model used to generate the summary, as "providerID/modelID" ' +
        '(e.g. "anthropic/claude-sonnet-4-20250514"). Defaults to the configured model.',
    },
    mode: {
      type: 'string',
      enum: ['state', 'summary'],
      default: 'summary',
      description:
        '"state" returns only the session state (running/idle/waiting/finished) ' +
        'without an LLM call. "summary" also generates an LLM summary.',
    },
  },
  required: ['sessionID'],
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    sessionID: { type: 'string' },
    state: {
      type: 'string',
      description: 'Session state: running, idle, waiting, or finished.',
    },
    summary: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['sessionID'],
  additionalProperties: false,
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Small, total helpers (never throw on unexpected shapes).
// ---------------------------------------------------------------------------

function truncate(value, max) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/** Pull text out of a string / { text } / { data: { text } } result. */
function extractText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (value.data && typeof value.data === 'object' && typeof value.data.text === 'string') {
    return value.data.text;
  }
  return '';
}

/** Normalise the various message-list result shapes to a plain array. */
function asMessageArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.data)) return value.data;
  if (value.data && Array.isArray(value.data.data)) return value.data.data;
  return [];
}

/**
 * Parse an optional "providerID/modelID" string into the model ref the
 * generate API expects. Returns undefined when absent or malformed.
 */
function parseModel(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// Message rendering.
// ---------------------------------------------------------------------------

function roleLabel(message) {
  const type = message && message.type;
  switch (type) {
    case 'user':
      return 'USER';
    case 'assistant':
      return 'ASSISTANT';
    case 'synthetic':
      return 'SYSTEM (synthetic)';
    case 'system':
      return 'SYSTEM';
    case 'skill':
      return 'SYSTEM (skill)';
    case 'shell':
      return 'SYSTEM (shell)';
    case 'agent-switched':
      return 'SYSTEM (agent switched)';
    case 'model-switched':
      return 'SYSTEM (model switched)';
    case 'location-switched':
      return 'SYSTEM (location switched)';
    default:
      return type ? `SYSTEM (${type})` : 'MESSAGE';
  }
}

/** Render an assistant message's content parts (text + compact tool calls). */
function assistantBody(message) {
  const parts = Array.isArray(message && message.content) ? message.content : [];
  const out = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      out.push(part.text.trim());
    } else if (part.type === 'tool') {
      const state = part.state && typeof part.state === 'object' ? part.state : {};
      const status = typeof state.status === 'string' ? state.status : 'unknown';
      let detail = '';
      if (status === 'completed') {
        const content = Array.isArray(state.content) ? state.content : [];
        detail = content
          .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
          .join(' ')
          .trim();
      } else if (status === 'error') {
        detail = state.error && state.error.message ? state.error.message : 'error';
      } else if (status === 'running') {
        detail = 'running';
      }
      out.push(`[tool ${part.name || '?'} ${status}${detail ? ': ' + truncate(detail, 300) : ''}]`);
    }
    // reasoning parts are intentionally omitted — noise for a status summary.
  }
  if (message && message.error && message.error.message) {
    out.push(`[error: ${message.error.message}]`);
  }
  if (message && message.finish && message.finish !== 'stop') {
    out.push(`[finish: ${message.finish}]`);
  }
  return out.join('\n');
}

function messageBody(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.type === 'assistant') return assistantBody(message);
  if (typeof message.text === 'string') return message.text.trim();
  return '';
}

/** Format messages (chronological) as a plain-text conversation. */
function formatTranscript(messages) {
  const lines = [];
  for (const message of messages) {
    const body = messageBody(message);
    if (!body) continue;
    lines.push(`${roleLabel(message)}: ${body}`);
  }
  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Read the target session's recent messages.
// ---------------------------------------------------------------------------

/**
 * Returns messages in chronological order (most recent last), capped to `limit`.
 * Tries, in order:
 *   1. ctx.session.messages({ sessionID, order: "desc", limit })  (future-proof)
 *   2. ctx.session.context({ sessionID })                          (v2.0.6 actual)
 *   3. ctx.rpc.message.list / ctx.rpc.session.messages             (defensive)
 */
async function readMessages(ctx, sessionID, limit) {
  const session = ctx && ctx.session;

  // 1. Task-specified surface (present on newer runtimes, absent on v2.0.6).
  if (session && typeof session.messages === 'function') {
    try {
      const result = await session.messages({ sessionID, order: 'desc', limit });
      const messages = asMessageArray(result);
      if (messages.length) return messages.slice().reverse(); // desc -> chronological
    } catch {
      /* fall through */
    }
  }

  // 2. v2.0.6 plugin surface: active context messages (chronological).
  if (session && typeof session.context === 'function') {
    try {
      const result = await session.context({ sessionID });
      const messages = asMessageArray(result);
      if (messages.length) return messages.slice(-limit);
    } catch {
      /* fall through */
    }
  }

  // 3. Defensive: the embedded client, if it happens to be exposed as ctx.rpc.
  const rpc = ctx && ctx.rpc;
  if (rpc) {
    try {
      if (rpc.message && typeof rpc.message.list === 'function') {
        const result = await rpc.message.list({ sessionID, order: 'desc', limit });
        const messages = asMessageArray(result);
        if (messages.length) return messages.slice().reverse();
      }
      if (rpc.session && typeof rpc.session.messages === 'function') {
        const result = await rpc.session.messages({ sessionID, order: 'desc', limit });
        const messages = asMessageArray(result);
        if (messages.length) return messages.slice().reverse();
      }
    } catch {
      /* fall through */
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Generate the summary.
// ---------------------------------------------------------------------------

function buildPrompt(transcript) {
  return [
    "You are summarising a subagent's conversation for its parent agent.",
    "Write a concise 2-4 sentence summary of the subagent's CURRENT STATE.",
    'Focus on: (1) what it is doing right now; (2) status — running, completed,',
    'failed, or blocked; (3) key findings or decisions; (4) blockers; and',
    '(5) the most likely next step. Do not dump raw messages, tool output, or',
    'code. Output only the summary prose, with no preamble.',
    '',
    '--- SUBAGENT CONVERSATION (most recent last) ---',
    transcript,
    '--- END CONVERSATION ---',
  ].join('\n');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the target session's own model via `ctx.session.get`, returning a
 * Model.Ref `{ id, providerID, variant? }` or undefined. Used only by the
 * stateless fallback so it still defaults to the session's agent model.
 */
async function readSessionModel(ctx, sessionID) {
  const get = ctx && ctx.session && ctx.session.get;
  if (typeof get !== 'function') return undefined;
  try {
    const result = await get({ sessionID });
    // Tolerate both a bare Session.Info and a `{ data: Session.Info }` envelope.
    const session =
      result && typeof result === 'object' && result.data && typeof result.data === 'object'
        ? result.data
        : result;
    const model = session && typeof session === 'object' ? session.model : undefined;
    if (!model || typeof model !== 'object') return undefined;
    if (typeof model.id !== 'string' || typeof model.providerID !== 'string') return undefined;
    return {
      id: model.id,
      providerID: model.providerID,
      ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Generate the summary.
 *
 * Order of preference:
 *   1. Explicit `model` override -> `ctx.generate.text({ prompt, model })`.
 *   2. `ctx.session.generate({ sessionID, prompt })` — the LEGAL default. It
 *      runs as the target session, so it works with the free tier and uses the
 *      session's own agent + model (the endpoint has no model parameter).
 *   3. Stateless `ctx.generate.text`, preferring the session's model read via
 *      `ctx.session.get`.
 *
 * Each mechanism is attempted defensively; if all fail the collected errors are
 * reported instead of a generic message.
 */
async function generateSummary(ctx, { sessionID, prompt, model }) {
  const errors = [];

  const trySessionGenerate = async () => {
    const fn = ctx && ctx.session && ctx.session.generate;
    if (typeof fn !== 'function') return undefined;
    try {
      const text = extractText(await fn({ sessionID, prompt })).trim();
      return text || undefined;
    } catch (error) {
      errors.push(`ctx.session.generate: ${errorMessage(error)}`);
      return undefined;
    }
  };

  const tryGenerateText = async (ref) => {
    const fn = ctx && ctx.generate && ctx.generate.text;
    if (typeof fn !== 'function') return undefined;
    try {
      const text = extractText(await fn(ref ? { prompt, model: ref } : { prompt })).trim();
      return text || undefined;
    } catch (error) {
      errors.push(`ctx.generate.text: ${errorMessage(error)}`);
      return undefined;
    }
  };

  // 1. Explicit override: only the stateless API can honour a chosen model.
  if (model) {
    const overridden = await tryGenerateText(model);
    if (overridden) return overridden;
  }

  // 2. Default (legal): session-scoped generation. Uses the session's agent and
  //    model automatically, and is attributed to a real session.
  const sessionScoped = await trySessionGenerate();
  if (sessionScoped) return sessionScoped;

  // 3. Fallback: stateless generation, defaulting to the session's own model.
  const fallbackModel = model || (await readSessionModel(ctx, sessionID));
  const stateless = await tryGenerateText(fallbackModel);
  if (stateless) return stateless;

  throw new Error(
    'no text-generation API succeeded (ctx.session.generate / ctx.generate.text)' +
      (errors.length ? `: ${errors.join('; ')}` : ''),
  );
}

// ---------------------------------------------------------------------------
// State determination.
// ---------------------------------------------------------------------------

/**
 * Determine the session state: 'running', 'idle', 'waiting', or 'finished'.
 *
 * Logic:
 *   1. If ctx.session.get reports an outcome of succeeded/failed/interrupted,
 *      the session is 'finished'.
 *   2. Otherwise, inspect the last message:
 *      - No messages -> 'idle'
 *      - Last message is 'user' -> 'idle' (waiting for agent to respond)
 *      - Last message is 'assistant' with a running/streaming tool -> 'running'
 *      - Last message is 'assistant' with all tools completed -> 'waiting'
 *      - Anything else -> 'idle'
 *
 * On any error, returns 'idle' as a safe default.
 */
async function determineState(ctx, sessionID, messages) {
  try {
    // 1. Check session outcome via ctx.session.get.
    const get = ctx && ctx.session && ctx.session.get;
    if (typeof get === 'function') {
      const result = await get({ sessionID });
      const info =
        result && typeof result === 'object' && result.data && typeof result.data === 'object'
          ? result.data
          : result;
      if (info && typeof info === 'object') {
        const outcome = info.outcome;
        if (outcome === 'succeeded' || outcome === 'failed' || outcome === 'interrupted') {
          return 'finished';
        }
      }
    }

    // 2. Message-based logic.
    if (!Array.isArray(messages) || messages.length === 0) return 'idle';

    const last = messages[messages.length - 1];
    if (!last || typeof last !== 'object') return 'idle';

    if (last.type === 'user') return 'idle';

    if (last.type === 'assistant') {
      const content = Array.isArray(last.content) ? last.content : [];
      for (const part of content) {
        if (part && part.type === 'tool' && part.state) {
          const status = part.state.status;
          if (status === 'running' || status === 'streaming') return 'running';
        }
      }
      return 'waiting';
    }

    return 'idle';
  } catch {
    return 'idle';
  }
}

// ---------------------------------------------------------------------------
// Tool definition.
// ---------------------------------------------------------------------------

function makeTool(ctx) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    options: { codemode: false },
    input: INPUT_SCHEMA,
    output: OUTPUT_SCHEMA,
    execute: async (input) => {
      const args = input && typeof input === 'object' ? input : {};
      const sessionID = typeof args.sessionID === 'string' ? args.sessionID.trim() : '';
      const mode = args.mode === 'state' ? 'state' : 'summary';

      if (!sessionID) {
        const message = 'subagent-status: `sessionID` is required.';
        return { output: { sessionID: '', state: 'idle', error: 'missing-sessionID' }, content: message };
      }

      const limit =
        Number.isInteger(args.limit) && args.limit > 0
          ? Math.min(args.limit, MAX_LIMIT)
          : DEFAULT_LIMIT;
      const model = parseModel(args.model);

      let state = 'idle';
      try {
        const messages = await readMessages(ctx, sessionID, limit);
        state = await determineState(ctx, sessionID, messages);

        if (mode === 'state') {
          return { output: { sessionID, state }, content: state };
        }

        if (!messages.length) {
          const summary =
            `No messages were found for session ${sessionID}. It may not have ` +
            'started yet, may have been deleted, or the session id may be wrong.';
          return { output: { sessionID, state, summary }, content: summary };
        }

        const transcript = formatTranscript(messages);
        const prompt = buildPrompt(transcript);
        const summary = await generateSummary(ctx, { sessionID, prompt, model });

        return { output: { sessionID, state, summary }, content: summary };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          output: { sessionID, state, error: message },
          content: `subagent-status: failed to summarise session ${sessionID}: ${message}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// setup.
// ---------------------------------------------------------------------------

function setup(ctx) {
  try {
    if (!ctx || !ctx.tool || typeof ctx.tool.transform !== 'function') {
      try {
        console.warn('[subagent-status] ctx.tool.transform unavailable; tool not registered');
      } catch {
        /* ignore */
      }
      return;
    }

    const result = ctx.tool.transform((editor) => {
      if (!editor || typeof editor.add !== 'function') return;
      editor.add(makeTool(ctx));
    });

    // `transform` may be effect/promise-based on some runtimes; swallow failures.
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (error) {
    // Fail-safe: a plugin error must never break OpenCode startup.
    try {
      console.error(
        '[subagent-status] setup failed:',
        error && error.message ? error.message : error,
      );
    } catch {
      /* ignore */
    }
  }
}

export default {
  id: 'subagent-status',
  setup,
};
