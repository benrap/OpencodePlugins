# always-background

An OpenCode V2 plugin that actively forces **background execution** for `shell`
and `subagent` tool calls, so long-running work never blocks the session.

## How it works

The plugin registers an `execute.before` tool hook and mutates each matching
tool's input in place:

```js
event.input.background = true;
```

It re-registers on every `setup()` (the host drops a plugin generation's
registrations when that generation is replaced) and never disposes the
registration. Everything is wrapped in `try/catch` so a plugin error can never
break host startup.

## Install

```bash
opencode plugin add ./always-background
```

Or reference the path in `opencode.jsonc`:

```jsonc
{ "plugins": [{ "package": "./always-background" }] }
```

## Debug logging

Off by default. Enable it by setting `ALWAYS_BACKGROUND_DEBUG_FILE` to a file
path, or by creating a file named `always-background.debug` next to `index.js`.
