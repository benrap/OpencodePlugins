import { installAbortTool } from "./subagent-abort.ts"

export default {
  id: "subagent-abort",
  setup(ctx?: unknown) {
    try {
      installAbortTool(ctx)
    } catch {
      /* never break host startup */
    }
  },
}
