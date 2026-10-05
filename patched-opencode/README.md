# opencode-patched

A runnable **Windows x64** build of OpenCode based on upstream v2.0.23 (tag `v2.0.23`, commit `0fd7e2829449b052abf0078666669302923d77af`), plus a small patch set that adds a session **waiting** status and removes the subagent sidebar gate.

---

## Download & run (Windows x64, no dependencies)

**Direct download:**

<https://github.com/benrap/OpencodePlugins/releases/download/patched-v2.0.23/opencode-patched-windows-x64.zip>

**Steps:**

1. Download `opencode-patched-windows-x64.zip` from the link above.
2. Unzip it to a folder of your choice.
3. Run `opencode.exe` from that folder.
   - Optionally, add the folder to your `PATH` so you can run `opencode` from anywhere (see [Install into PATH](#install-into-path-optional)).

No `bun`, no `node`, and no source tree are required — the zip contains a self-contained binary.

**Notes:**

- On first use of `grep`/`glob`, OpenCode may download `ripgrep` automatically. This is standard OpenCode behavior; everything else in the zip is self-contained.
- The binary is **unsigned**, so Windows SmartScreen may show a warning. Choose "More info" → "Run anyway" if you trust this build.

---

## What this is

This is patched OpenCode built from upstream **v2.0.23** with the changes documented in [PATCHES.md](./PATCHES.md). In short:

- A **waiting** session status: while a turn's background work (shell jobs, nested subagents) is still outstanding, `Execution.Succeeded` is withheld and the session reports `waiting` instead of flashing a spurious "done" tick.
- The TUI treats `waiting` as busy (running), shows a "waiting for background work…" indicator, and does not render the completion tick until the work truly finishes.
- The **subagent sidebar gate** is removed, so child/subagent sessions render in the sidebar tree regardless of their `parentID`.
- Aborting a session also cancels its pending background jobs, and subagent completion now waits for child background work before finalizing its response.

For the exact per-file diff (all 20 changed files, before/after hunks, grouping, and how to apply the patches to a clean checkout), see **[PATCHES.md](./PATCHES.md)**.

---

## Patch files

Two patch files are provided:

| Patch | Contents |
|-------|----------|
| `patches/0001-remove-parentid-sidebar-gate.patch` | Removes the `parentID` sidebar gate in `packages/tui/src/component/session-frame.tsx`. |
| `patches/0002-session-waiting-status-tick-fix.patch` | The waiting-status feature and completion-tick fix across schema/client/core/app/tui/plugin, plus tests (19 files). |

Both apply cleanly to a clean upstream **v2.0.23** checkout, and applying both reproduces the source tree this binary was built from. See [PATCHES.md](./PATCHES.md) for the exact `git apply` commands and the verified tree hash.

---

## Install into PATH (optional)

The `scripts/` folder contains helpers that point a command on your `PATH` at the patched standalone binary:

| Script | Purpose |
|--------|---------|
| `scripts/install-shim.ps1` | Fresh install: creates `%USERPROFILE%\.opencode-patched\opencode.cmd` that launches the patched binary. |
| `scripts/switch-patched.ps1` | Prepends the shim directory to your User `PATH` so `opencode` resolves to the patched binary. |
| `scripts/revert-patched.ps1` | Removes the shim directory from your User `PATH`, restoring the stock `opencode`. |

Run them with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-shim.ps1
powershell -ExecutionPolicy Bypass -File scripts\switch-patched.ps1
# ... later, to go back to stock:
powershell -ExecutionPolicy Bypass -File scripts\revert-patched.ps1
```

The generated `%USERPROFILE%\.opencode-patched\opencode.cmd` launches the patched binary from this artifact.

---

## Build from source (optional)

If you would rather build the binary yourself from the patched source tree:

```powershell
cd packages/cli
$env:OPENCODE_VERSION="2.0.23-patched"; $env:OPENCODE_CHANNEL="prod"
bun --bun ./script/build.ts --single --skip-install
# => packages/cli/dist/cli-windows-x64/bin/opencode.exe
```
