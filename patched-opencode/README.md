# opencode-patched

A reversible shim that makes the `opencode` command launch a **patched** build from source, without touching the stock installation.

## What the patch does

The patched source (an opencode checkout, e.g. `<opencode-checkout>`, branch `benrap/session-waiting-status`) includes these changes on top of stock opencode v2.0.22:

1. **ParentID sidebar gate removal** (`packages/tui/src/component/session-frame.tsx`) — subagent sessions are now rendered in the sidebar regardless of their `parentID`, so you can see all active sessions in the tree.

2. **Waiting / tick fix** (`packages/core/src/session/execution.ts`, `packages/tui/src/routes/session/index.tsx`, `packages/tui/src/context/session-tabs.tsx`) — the completion tick is suppressed while a session is in the `waiting` state, and `waiting` is treated as a non-idle (busy) status so the TUI doesn't flash a spurious "done" indicator.

3. **Abort fix** — session abort handling is corrected so that aborting a waiting session properly transitions it out of the waiting state.

4. **Client type** (`packages/client/src/promise/generated/types.ts`) — adds `{ type: "waiting" }` to the generated session status union.

5. **Test** (`packages/core/test/session-execution.test.ts`) — covers the waiting/tick behavior.

> **Note:** The changes are committed locally on branch `benrap/session-waiting-status` (not pushed). The shim runs the working tree directly via `bun run`, so any further edits to the source are picked up immediately on the next invocation — no rebuild needed.

> **Patch scope:** The patches in `patches/` are cumulative diffs against the `v2` merge-base (`40679546d4`), covering the full feature branch (7 commits). They apply cleanly to a stock opencode v2.0.22 checkout with `git apply patches/0001-*.patch patches/0002-*.patch`.

## How it works

A small `opencode.cmd` shim is placed in `%USERPROFILE%\.opencode-patched\` (or `$env:OPENCODE_PATCHED_DIR` when set). The switch script prepends that directory to your User PATH. In new shells, `opencode` resolves to the shim, which calls:

```
bun run --cwd "<opencode-checkout>\packages\cli" src/index.ts %*
```

This runs the patched TypeScript source directly via Bun — no compiled binary needed.

## Apply (switch to patched)

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.opencode-patched\switch-patched.ps1"
```

Then open a **new** cmd or PowerShell window and verify:

```
opencode --version
# should print: opencode vlocal
```

## Revert (back to stock)

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.opencode-patched\revert-patched.ps1"
```

Then open a new window — `opencode` will resolve to the stock binary at `%USERPROFILE%\.opencode\bin\opencode.exe` again.

## Build a compiled binary (optional)

If you prefer a standalone `.exe` instead of running from source:

```powershell
cd <opencode-checkout>
bun build --compile --outfile opencode-patched.exe packages/cli/src/index.ts
```

Then point the shim at the compiled binary instead of `bun run`.

## Configuration

The scripts derive their paths at runtime so no machine-specific path is committed:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCODE_PATCHED_DIR` | `%USERPROFILE%\.opencode-patched` | Where the shim lives and what gets added to User PATH |
| `OPENCODE_PATCHED_SOURCE` | `<shim-dir>\opencode-src\packages\cli` | The opencode checkout's `packages\cli` to run |
| `BUN_EXE` | `bun` from `PATH` | Explicit path to `bun.exe` if it is not on `PATH` |

## Guard

A pre-commit guard rejects machine-specific local paths (an absolute Windows
user-profile path, an OS temp `AppData` path, or a temp-checkout name) from ever
being committed again:

```powershell
# Scan all tracked files (exit 1 and list offenders when a leak is present)
powershell -ExecutionPolicy Bypass -File .\patched-opencode\scripts\check-no-local-paths.ps1

# Install the guard as a .git/hooks/pre-commit hook (re-run after a fresh clone)
powershell -ExecutionPolicy Bypass -File .\patched-opencode\scripts\install-git-hooks.ps1

# Prove the guard works end-to-end (plants a leak, expects a failure, then a pass)
powershell -ExecutionPolicy Bypass -File .\patched-opencode\scripts\test-no-local-paths-guard.ps1
```

The checker deliberately allows the bare GitHub username `benrap` in URLs,
`"author"` fields, LICENSE copyright lines, and the branch name
`benrap/session-waiting-status`; it only flags actual filesystem paths.

## Files

| Path | Purpose |
|------|---------|
| `scripts/opencode.cmd` | The shim that launches the patched source |
| `scripts/switch-patched.ps1` | Prepends the shim dir to User PATH |
| `scripts/revert-patched.ps1` | Removes the shim dir from User PATH |
| `scripts/install-shim.ps1` | Creates the shim dir and writes `opencode.cmd` (fresh installs) |
| `scripts/check-no-local-paths.ps1` | Scans tracked files for machine-specific local paths |
| `scripts/install-git-hooks.ps1` | Installs the pre-commit hook that runs the checker |
| `scripts/test-no-local-paths-guard.ps1` | Self-test for the checker (fails on a plant, passes when clean) |
| `patches/0001-remove-parentid-sidebar-gate.patch` | Patch: sidebar gate removal |
| `patches/0002-session-waiting-status-tick-fix.patch` | Patch: waiting/tick/abort fix + client type + test |
