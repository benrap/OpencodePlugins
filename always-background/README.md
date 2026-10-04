# always-background

An OpenCode V2 plugin that actively forces **background execution** for every
tool call **except** `shell` and `subagent` (which have their own `background`
input the user controls explicitly). This prevents tools like `read`, `edit`,
`subagent-status`, etc. from blocking the session.

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

## Configuration

The exclude list is configurable via the plugin option `exclude`. If not
provided, it defaults to `['shell', 'subagent']`.

```jsonc
{
  "plugins": [
    {
      "package": "./always-background",
      "options": { "exclude": ["shell", "subagent"] }
    }
  ]
}
```

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
