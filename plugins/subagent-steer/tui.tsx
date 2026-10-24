/** @jsxImportSource @opentui/solid */

/**
 * subagent-steer — TUI entrypoint.
 *
 * WHY A KEYBIND + DIALOG (and not an inline slot input)
 * -----------------------------------------------------
 * The task's primary idea was to render a focusable single-line `<input>` in
 * the `session.composer.top` slot and submit the steer on Enter. Investigation
 * of the v2.0.23 TUI source shows that is NOT achievable with the supported
 * plugin API, for a concrete reason:
 *
 *   1. For EVERY child session the host forces its "composer" open:
 *        routes/session/index.tsx:1458/1472
 *          composer.open || (!!session()?.parentID && forms().length === 0)
 *      and the composer pushes the mutually-exclusive keymap mode "composer"
 *      (routes/session/composer/index.tsx:63-67, priority 1, enabled while open).
 *
 *   2. In that mode the host binds exactly the keys an inline input would need
 *      to submit/clear itself:
 *        config/keybind.ts:247  "composer.subagent.select": "return"
 *        config/keybind.ts:245  "composer.subagent.up":     "up"
 *        config/keybind.ts:246  "composer.subagent.down":   "down"
 *        routes/session/composer/index.tsx:83  escape -> close composer
 *
 *   3. The host keymap is registered with `renderer.keyInput.prependListener`
 *      (@opentui/keymap/src/opentui.js:69-74), i.e. command bindings observe a
 *      key BEFORE the focused renderable's own `handleKeyPress`
 *      (@opentui/core .../Renderable.focus(): registers `keypressHandler`).
 *      A matched binding `preventDefault`s the event, so the focused
 *      `InputRenderable` never sees Enter/Escape.
 *
 *   => A slot `<input>` can receive printable characters but cannot receive the
 *      Enter needed to submit (it would instead navigate to the selected
 *      subagent). Overriding the host's mode-composer bindings from a plugin
 *      layer (mode/target/priority) is possible but fragile and would also
 *      break the composer's own select-subagent UX. See `README.md`.
 *
 * The robust, supported alternative is `context.keymap.layer(...)` +
 * `context.ui.dialog.prompt(...)`: the dialog runs in the host's modal scope
 * with its own focused textarea and its Enter bound to `dialog.prompt.submit`
 * (config/keybind.ts:264), so typing and Enter both work regardless of the
 * composer. We implement that, plus a small informational hint in the composer
 * slot so the affordance is discoverable.
 */

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { Show } from "solid-js"
import { resolveSteerTarget, steerSession, type SteerClient } from "./steer"

const PLUGIN_ID = "subagent-steer"
/** Stable command/config keybind identifier (configurable via `keybinds`). */
const COMMAND_ID = "subagent.steer"
/** Default shortcut if the user has not configured one. */
const COMMAND_BIND = "ctrl+shift+s"

function currentRoute(context: Context) {
  try {
    return context.ui.router.current()
  } catch {
    return undefined
  }
}

/** The child session currently being viewed, or `null`. */
function steerTarget(context: Context): string | null {
  return resolveSteerTarget(currentRoute(context), (sessionID) =>
    context.data.session.get(sessionID) as { parentID?: string | null } | undefined,
  )
}

/**
 * Informational (non-focusable) hint shown above the composer ONLY while the
 * viewed session is a child. It renders text, never captures keys, so it cannot
 * fight the host composer.
 */
export function SteerHint(props: { context: Context; sessionID: string }) {
  const session = () => props.context.data.session.get(props.sessionID) as
    | { parentID?: string | null }
    | undefined
  const shortcut = () => {
    try {
      return props.context.keymap.shortcuts(COMMAND_ID)[0]
    } catch {
      return undefined
    }
  }
  return (
    <Show when={session()?.parentID}>
      <box width="100%">
        <text fg={props.context.theme.text.muted} wrapMode="none">
          Steer this subagent: {shortcut() ?? COMMAND_BIND}
        </text>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const unregisterSlot = context.ui.slot({
      prepend: "session.composer.top",
      render: (input) => <SteerHint context={context} sessionID={input.sessionID} />,
    })

    // A global-mode layer (not `base`) so the command is reachable while the
    // host composer's "composer" mode is active on a child session.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: COMMAND_ID,
          title: "Steer viewed subagent",
          description: "Send a steering message to the child subagent session you are viewing",
          group: "Session",
          palette: true,
          bind: COMMAND_BIND,
          slash: { name: "steer" },
          run: async () => {
            const sessionID = steerTarget(context)
            if (!sessionID) {
              context.ui.toast.show({ message: "Not viewing a subagent" })
              return
            }
            const value = await context.ui.dialog.prompt({
              title: "Steer subagent",
              placeholder: "Message to the running subagent…",
            })
            if (value === undefined) return
            await steerSession(context.client as unknown as SteerClient, sessionID, value)
          },
        },
      ],
    }))

    // The keymap layer is owned and disposed by the plugin framework
    // (packages/tui/src/plugin/api.tsx:146-151,179-192); the slot registration
    // returns its own unregister fn, which we forward here.
    return () => {
      unregisterSlot()
    }
  },
})
