/** @jsxImportSource @opentui/solid */

/**
 * subagent-abort-tui — TUI entrypoint.
 *
 * Adds a single keybind command (`ctrl+d` by default) and the `/abort` slash
 * command that interrupt the CHILD subagent session currently in view AND its
 * entire descendant subagent subtree, recursively. Both are child-only: while a
 * main/root session (no `parentID`) or a non-session route is in view the
 * command is disabled and the run body is a no-op, so this can never abort the
 * main session.
 *
 * The keymap layer is owned and disposed by the plugin framework
 * (packages/tui/src/plugin/api.tsx), so no unregister fn is returned here.
 */

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { COMMAND_ID, SLASH_NAME, abortSubtree, abortToast, resolveViewedChild, type AbortClient } from "./abort"

const PLUGIN_ID = "subagent-abort-tui"
/** Default shortcut if the user has not configured one. */
const COMMAND_BIND = "ctrl+d"

function currentRoute(context: Context) {
  try {
    return context.ui.router.current()
  } catch {
    return undefined
  }
}

/** The child session currently being viewed, or `null`. Never throws. */
function viewedChildId(context: Context): string | null {
  try {
    return resolveViewedChild(currentRoute(context), (sessionID) =>
      context.data.session.get(sessionID) as { parentID?: string | null } | undefined,
    )
  } catch {
    return null
  }
}

/**
 * Adapt the plugin client to `AbortClient`.
 *
 * `list` is called exactly like `subagent-sidebar-tree`'s `syncChildren`
 * (`session.list({ parentID, order: "desc" })`). `cancelBackground` is a NEW
 * `session.interrupt` field (core patch `0004`) that the plugin's bundled type
 * definitions may not list yet — the host supports it — so the client is cast
 * rather than fought with types.
 */
function abortClient(context: Context): AbortClient {
  return {
    session: {
      list: ({ parentID }) => context.client.session.list({ parentID, order: "desc" }),
      interrupt: (input) => context.client.session.interrupt(input),
    },
  } as unknown as AbortClient
}

/**
 * Abort (interrupt) the viewed child session and its whole descendant subtree.
 *
 * Descendants are interrupted before the viewed session (see `interruptOrder`),
 * each with `cancelBackground: true`. Shows ONE toast with the count, or a
 * failure toast. Never throws.
 */
async function abortViewed(context: Context): Promise<void> {
  const sessionID = viewedChildId(context)
  if (!sessionID) return
  try {
    const result = await abortSubtree(abortClient(context), sessionID)
    const toast = abortToast(result)
    context.ui.toast.show({ message: toast.message, variant: toast.variant })
  } catch {
    context.ui.toast.show({ message: "Failed to abort subagent", variant: "error" })
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    // A global-mode layer so the command is reachable while the host
    // composer's "composer" mode is active on a child session.
    context.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      commands: [
        {
          id: COMMAND_ID,
          title: "Abort viewed subagent",
          description:
            "Abort (interrupt) the child subagent session you are viewing and its descendant subagents",
          group: "Session",
          palette: true,
          bind: COMMAND_BIND,
          slash: { name: SLASH_NAME },
          enabled: () => viewedChildId(context) !== null,
          run: () => abortViewed(context),
        },
      ],
    }))
  },
})
