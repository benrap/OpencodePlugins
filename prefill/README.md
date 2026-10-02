# prefill

An OpenCode V2 plugin for **per-message opt-in message injection**: when the user
ends a message with the marker `#prefill`, the plugin injects extra messages into
the outgoing model request (assistant prefill / conversation steering). The
marker is stripped before persistence, so the model never sees it and it never
appears in the saved transcript.

Prefill is **off by default** — no marker means no injection.

## Usage

End a message with `#prefill` (case-sensitive, optionally followed by
whitespace) to arm injection for that turn:

```
Continue the refactor #prefill
```

The marker is removed from your message and the configured seed is injected
immediately before model dispatch.

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
        "mode": "assistant-prefill",
        "seed": "Understood — I will continue the conversation naturally from here."
      }
    }
  ]
}
```

## Modes & options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `mode` | `assistant-prefill` | `assistant-prefill`, `steer-pair`, `reasoning`, `reasoning-continue`, or `think-reply-continue`. |
| `seed` | placeholder | The injected assistant text. |
| `userSeed` | placeholder | Injected user text for the modes that add a trailing user turn. |
| `debug` | `false` | Write a trace (also enabled by a `prefill.debug` sentinel file next to `index.js`). |
| `captureHttp` | `false` | Capture the raw outgoing request body to JSON files. |

Environment overrides (`PREFILL_SEED`, `PREFILL_MODE`, `PREFILL_USER_SEED`,
`PREFILL_DISABLED=1`, `PREFILL_DEBUG=1`, `PREFILL_CAPTURE_HTTP=1`,
`PREFILL_DEBUG_FILE=<path>`) are also supported.
