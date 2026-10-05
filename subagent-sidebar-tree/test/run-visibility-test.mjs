/**
 * Runs the OpenTUI visibility test in a throwaway harness.
 *
 * The test imports the plugin's `tui.tsx`, which imports `@opentui/*` and
 * `solid-js`. The live plugin folder deliberately has no `node_modules` (the
 * running TUI resolves those itself), so we copy the plugin sources and the
 * test into a temp folder, link `node_modules` at an OpenCode checkout that
 * has the OpenTUI packages, run `bun test`, and clean up.
 *
 * Point `OPENTUI_NODE_MODULES` at a `node_modules` containing `@opentui/core`,
 * `@opentui/solid` and `solid-js` if the default path is wrong.
 *
 *   node test/run-visibility-test.mjs
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, "..")
function resolveDepRoot() {
  const configured = process.env.OPENTUI_NODE_MODULES
  if (configured) return configured
  const checkout = process.env.OPENCODE_CHECKOUT
  if (checkout) {
    const candidate = join(checkout, "packages", "tui", "node_modules")
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
const depRoot = resolveDepRoot()
if (!depRoot) {
  console.error(
    "OPENTUI_NODE_MODULES is not set and no OpenCode checkout was found.\n" +
      "Set OPENTUI_NODE_MODULES to a node_modules containing @opentui/core, " +
      "@opentui/solid and solid-js (or set OPENCODE_CHECKOUT to an OpenCode source checkout).",
  )
  process.exit(1)
}
const harness = join(tmpdir(), "subagent-sidebar-visibility-harness")

rmSync(harness, { recursive: true, force: true })
mkdirSync(join(harness, "test"), { recursive: true })

for (const file of ["tui.tsx", "subagent-view.ts"]) {
  copyFileSync(join(plugin, file), join(harness, file))
}
copyFileSync(
  join(here, "subagent-sidebar-visibility.test.tsx"),
  join(harness, "test", "subagent-sidebar-visibility.test.tsx"),
)
writeFileSync(join(harness, "bunfig.toml"), '[test]\npreload = ["@opentui/solid/preload"]\n')
symlinkSync(depRoot, join(harness, "node_modules"), "junction")

let status = 1
try {
  const result = spawnSync("bun", ["test", "test/subagent-sidebar-visibility.test.tsx"], {
    cwd: harness,
    stdio: "inherit",
    shell: true,
  })
  status = result.status ?? 1
} finally {
  rmSync(harness, { recursive: true, force: true })
}
process.exit(status)
