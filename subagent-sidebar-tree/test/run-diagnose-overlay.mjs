/**
 * Diagnostic runner: renders the real `SubagentSidebar` inside a faithful
 * reproduction of the core app/session-frame layout and prints every node's
 * geometry (x/y/w/h/zIndex/position/background) plus the captured character
 * frame, so the overlay's real behaviour can be inspected.
 *
 *   node test/run-diagnose-overlay.mjs
 */
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, "..")
const depRoot =
  process.env.OPENTUI_NODE_MODULES ??
  "<opencode-checkout>\\packages\\tui\\node_modules"
const harness = join(tmpdir(), "subagent-sidebar-diagnose-harness")

rmSync(harness, { recursive: true, force: true })
mkdirSync(join(harness, "test"), { recursive: true })

for (const file of ["tui.tsx", "subagent-view.ts"]) {
  copyFileSync(join(plugin, file), join(harness, file))
}
copyFileSync(join(here, "diagnose-overlay.test.tsx"), join(harness, "test", "diagnose-overlay.test.tsx"))
writeFileSync(join(harness, "bunfig.toml"), '[test]\npreload = ["@opentui/solid/preload"]\n')
symlinkSync(depRoot, join(harness, "node_modules"), "junction")

console.log(`harness: ${harness}`)

let status = 1
try {
  const result = spawnSync("bun", ["test", "test/diagnose-overlay.test.tsx"], {
    cwd: harness,
    stdio: "inherit",
    shell: true,
  })
  status = result.status ?? 1
} finally {
  // Keep the harness so the caller can inspect copied sources / re-run.
}
process.exit(status)
