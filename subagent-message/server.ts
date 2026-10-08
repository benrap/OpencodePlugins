import { installMessageTool } from "./subagent-message.ts"

export default {
  id: "subagent-message",
  setup(ctx?: unknown) {
    try {
      installMessageTool(ctx)
    } catch {
      /* never break host startup */
    }
  },
}
