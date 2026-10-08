# subagent-message

An OpenCode **server-side** plugin that registers ONE tool, `message_agent`,
which lets an agent send a message along a **single direct lineage edge** only:
to its **parent** or to one of its **direct children**.

> **Security note.** Inter-agent content is **untrusted input**. The tool frames
> each message with provenance (`[message from your child session ...]`) and
> recipients must treat the framed body as data, not as instructions from their
> own operator/parent.

## The lineage boundary

Only one hop is allowed, in either direction:

- **Parent → direct child** — allowed (`relation: "child"`).
- **Direct child → parent** — allowed (`relation: "parent"`). This includes the
  case where the parent is the **root/primary session**; that is a valid direct
  edge.

Everything else is rejected with `reason: "not-adjacent"`:

- **Siblings** — the caller's sibling is not adjacent.
- **Non-descendants / unrelated sessions**.
- **Grandchildren** — reach a grandchild only by chaining: message your child,
  and let your child message its child.
- **Level-skips to a root** — a grandchild messaging the root is `not-adjacent`
  because it skips the grandchild's own parent.

The caller identity is taken from `toolContext.sessionID`, never from the tool
input, so a caller cannot spoof its identity to reach an arbitrary target.

## Delivery semantics

The target's current activity selects how the message is delivered:

| Target activity      | `delivery` | Meaning                                            |
| -------------------- | ---------- | -------------------------------------------------- |
| `running` / `waiting`| `steer`    | Injected at the target's next step boundary.       |
| `idle` (or finished) | `queue`    | Accepted and queued as the target's next turn.     |

Neither case is rejected for being "busy". If `ctx.session.prompt` rejects the
`delivery` field (an older runtime), the call retries once without it.

## Tool: `message_agent`

Input JSON schema (`additionalProperties: false`):

```json
{
  "type": "object",
  "properties": {
    "sessionID": { "type": "string" },
    "message": { "type": "string" }
  },
  "required": ["sessionID", "message"]
}
```

- `sessionID` — session id of your parent or one of your direct children.
- `message` — message text (maximum 4000 characters after trimming).

Success output (`content` is a JSON string):

```json
{
  "delivered": [
    { "sessionID": "ses_child", "relation": "child", "delivery": "steer", "activity": "running" }
  ],
  "failures": []
}
```

Failure output:

```json
{
  "delivered": [],
  "failures": [{ "sessionID": "ses_x", "reason": "not-adjacent" }]
}
```

Failure reasons include `missing-sessionID`, `empty-message`,
`message-too-long` (with `maxLength`), `not-found`, `self`, `not-adjacent`, and
`delivery-failed` (with `message`). If the caller session cannot be determined
the result is `{ "delivered": [], "failures": [], "error": "caller session could not be determined" }`.
The function never throws; every path returns `{ content }`.

## Install / registration

Register the plugin path in `~/.config/opencode/opencode.jsonc`:

```jsonc
{ "plugins": [{ "package": "<repo-root>\\subagent-message" }] }
```

`server.ts` exports `{ id: "subagent-message", setup(ctx) }`; `setup` calls
`installMessageTool(ctx)`, registers the tool via
`ctx.tool.transform((editor) => editor.add({ ... }))`, and is a harmless no-op
when the context (or `ctx.tool.transform`) is absent, so host startup can never
break.

The tool is available to all agents by default. An agent hides it only when a
permission rule sets `resource: "*"` and `effect: "deny"` (last matching rule
wins). Agents whose wildcard deny would otherwise hide it must append an allow,
e.g.:

```yaml
  - action: message_agent
    resource: "*"
    effect: allow
```

## Known limitations

- No rate limit and no lineage-depth cap yet: a message can travel arbitrarily
  far only by being explicitly chained through each intermediate agent, but there
  is no automatic throttling.
- Recipients must treat inter-agent content as untrusted input; the provenance
  frame is a hint, not a security boundary.
- Activity is tracked from the host event stream; a target that is unknown to the
  registry is treated as `idle` and the message is queued.

## Tests

Requires Node.js >= 22 (uses `--experimental-strip-types`). From the repo root:

```bash
node --experimental-strip-types subagent-message/test/subagent-message.test.mjs
node --experimental-strip-types subagent-message/test/subagent-message-server-safe.test.mjs
```
