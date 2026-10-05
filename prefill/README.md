# prefill

An OpenCode V2 plugin for **per-message opt-in message injection**. Embed the
literal, case-sensitive separator `#prefill` in a message to split it into parts:
the first part is sent (and persisted) as your user message, and the remaining
parts are appended to the outgoing model request as an alternating
assistant/user exchange — fabricating an assistant "prefill" and subsequent
turns that steer the reply.

Prefill is **strictly opt-in**: no marker means no injection, no rewrite.

## Usage

Separate the parts with `#prefill`. The marker is a **separator**, so it can
appear once or twice in the normal cases:

```
message1 #prefill message2 #prefill message3
```

This is interpreted as:

| Part | Text | Role | Where it goes |
| --- | --- | --- | --- |
| p1 | `message1` | user | persisted as your message |
| p2 | `message2` | assistant | appended to the request only |
| p3 | `message3` | user | appended to the request only |

The model therefore sees:

```
[user: message1, assistant: message2, user: message3]
```

and answers `message3`. What you type and what gets saved is only `message1`;
the markers and everything after the first marker are stripped from the
persisted transcript.

### Alternating roles

Roles alternate starting with **user**:

```
p1 = user   (persisted)
p2 = assistant
p3 = user
p4 = assistant
...
```

The first part is always the persisted user message. The rest are appended in
order via the `context` hook right before model dispatch.

### Request-only caveat

Parts **p2…pn are request-only**: they are injected into the model request but
are **not persisted**. When you reopen the session you will only see `p1`; the
fabricated assistant/user turns exist only for that model call. This is the
accepted trade-off of carrying the exchange inside a single user message.

### Trailing nudge

The request must end on a **user-role** part, otherwise the model may treat the
conversation as already finished and reply with an end-of-sequence. Whenever the
remaining parts end on an assistant part — i.e. an **odd number of remaining
parts**, equivalently an **even total number of parts** — the plugin appends a
trailing user nudge so the model still answers.

The nudge text is configurable via `trailingNudge` (default `"Continue"`):

```
message1 #prefill message2
```

⇒ `[user: message1, assistant: message2, user: Continue]` (nudge appended).

```
message1 #prefill message2 #prefill message3
```

⇒ `[user: message1, assistant: message2, user: message3]` (already ends on user;
no nudge).

### No-op cases

- **No marker** — nothing is injected and nothing is rewritten.
- **Marker-only** — a message that is only the marker(s), e.g. `#prefill` or
  `#prefill #prefill` (optionally with surrounding whitespace), is left
  untouched and does not arm injection. Stripping it would leave an empty,
  invalid user message.
- **Trailing marker with one non-empty part** — e.g. `message1 #prefill`
  persists `message1` but injects nothing (there is nothing to inject).

## Install

```bash
opencode plugin add ./prefill
```

Or reference the path in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "./prefill",
      "options": {
        "trailingNudge": "Continue"
      }
    }
  ]
}
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Set `false` (or `PREFILL_DISABLED=1`) to disable the plugin. |
| `trailingNudge` | `"Continue"` | User turn appended when the injected parts end on an assistant part, so the request ends on a user turn. |
| `debug` | `false` | Write a trace (also enabled by a `prefill.debug` sentinel file next to `index.js`, by `PREFILL_DEBUG=1`, or by `PREFILL_DEBUG_FILE=<path>`). |
| `captureHttp` | `false` | Capture the raw outgoing request body to JSON files (diagnostics). |

Environment overrides: `PREFILL_TRAILING_NUDGE`, `PREFILL_DISABLED=1`,
`PREFILL_DEBUG=1`, `PREFILL_DEBUG_FILE=<path>`, and `PREFILL_CAPTURE_HTTP=1`.
