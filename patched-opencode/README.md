# opencode-patched

A runnable **Windows x64** build of OpenCode based on upstream v2.0.27 (tag `v2.0.27`, commit `1f4d07a4a519185955ae8ab2ea3607805509e386`), plus a small patch set that adds a session **waiting** status, removes the subagent sidebar gate, makes the default interrupt **foreground-only**, and makes abort terminate cleanly (a cancelled job no longer revives its owner).

---

## How to run it (TL;DR)

1. **Prebuilt zip (simplest)** — download the `patched-v2.0.27` asset below, unzip it anywhere, and run `opencode.exe` from that folder.
2. **PATH shim** — if you already use the `%USERPROFILE%\.opencode-patched\opencode.cmd` shim, **quit every running `opencode` process and relaunch**; `opencode` then resolves to the patched build. If the shim directory is missing from your `PATH`, re-run `scripts\switch-patched.ps1` (see [Install into PATH](#install-into-path-optional)).
3. **Build from source** — see [Build from source](#build-from-source-optional).

**Confirm which build you are on:** `opencode --version` → `opencode v2.0.27-patched`.

**Roll back to stock:** `scripts\revert-patched.ps1` (removes the shim from `PATH`), or install the older `patched-v2.0.23` asset.

---

## Download & run (Windows x64, no dependencies)

**Direct download:**

<https://github.com/benrap/OpencodePlugins/releases/download/patched-v2.0.27/opencode-patched-windows-x64.zip>

**Steps:**

1. Download `opencode-patched-windows-x64.zip` from the link above.
2. Unzip it to a folder of your choice.
3. Run `opencode.exe` from that folder.
   - Optionally, add the folder to your `PATH` so you can run `opencode` from anywhere (see [Install into PATH](#install-into-path-optional)).

No `bun`, no `node`, and no source tree are required — the zip contains a self-contained binary.

> **Note:** the prebuilt zip above is the **`patched-v2.0.27`** release, built from
> the upstream v2.0.27 base. The previous **`patched-v2.0.23`** release is still
> available for rollback. To reproduce this build from source, apply
> [`patches/v2.0.27.patch`](./patches/v2.0.27.patch) or build from source (below).

**Notes:**

- On first use of `grep`/`glob`, OpenCode may download `ripgrep` automatically. This is standard OpenCode behavior; everything else in the zip is self-contained.
- The binary is **unsigned**, so Windows SmartScreen may show a warning. Choose "More info" → "Run anyway" if you trust this build.

---

## What this is

This is patched OpenCode built from upstream **v2.0.27** with the changes documented in [PATCHES.md](./PATCHES.md). In short:

- A **waiting** session status: while a turn's background work (shell jobs, nested subagents) is still outstanding, `Execution.Succeeded` is withheld and the session reports `waiting` instead of flashing a spurious "done" tick.
- The TUI treats `waiting` as busy (running), shows a "waiting for background work…" indicator, and does not render the completion tick until the work truly finishes.
- The **subagent sidebar gate** is removed, so child/subagent sessions render in the sidebar tree regardless of their `parentID`.
- **Inline steer composer for subagent sessions.** Viewing a child/subagent session now renders the normal host message composer; typing in it submits the text to the viewed child as a **steer** prompt (the host `Prompt` already defaults `delivery` to `"steer"` and targets its `sessionID`). The composer's **agent type** reflects that subagent's own agent (not the main agent's), the whole composer box uses a distinct **blue palette**, so the steer is associated with the right agent type and it is obvious who is being spoken to. The subagent picker is no longer force-opened for children — it stays reachable via the "Toggle subagent picker" command (`session.child.first`, default `down`). Main-session behavior is unchanged.
- Aborting a session can also cancel its pending background jobs — but only when the interrupt asks for it with `cancelBackground: true` (see `0005`); a default interrupt is foreground-only. Subagent completion now waits for child background work before finalizing its response.
- **Aborting a `waiting` session now actually stops it** (`0004`): a subagent that has settled its turn with outstanding durable background work sits in `waiting` with no live execution to interrupt, so its abort used to be a no-op. `SessionExecution.interrupt` now cancels that background work, clears its durable recovery marker, and publishes the interrupted terminal, so the child-composer Ctrl+D genuinely stops the waiting subagent. `0005` makes this cancellation opt-in via `cancelBackground: true`.
- **`Esc Esc` is foreground-only** (`0005`): `session.interrupt` gains an optional `cancelBackground` flag (default `false`). By default, interrupting stops only the **foreground** turn — it does **not** cancel the session's durable background jobs — and interrupting a `waiting` session (no active execution) is a **no-op**. This is what `Esc Esc` needs: stop the agent in front of you without touching background tasks. Passing `cancelBackground: true` restores the full-stop behavior (cancel outstanding background jobs, including settling a `waiting` session). Internal teardown callers that must not orphan background work (`Session.remove`, the inactivity reaper) pass `cancelBackground: true`.
- **Aborting a subagent stops it cleanly — no new turn** (`0006`): a cancelled background job or subagent still admits its terminal notice into the owner's context, but the notice now carries `resume: false` when `status === "cancelled"` (in `tool/plugin/shell.ts` `notifyWhenDone` and `session/subagent-completion.ts` `deliver`). Previously that notice was delivered with the default `resume: true`, so aborting a subagent woke the aborted session into a brand-new model turn (the subagent "dealt with the abortion") and revived the parent too. Now only `succeeded`/`failed`/`error` completions resume the owner, so an abort terminates the subagent cleanly — no follow-up turn, no focus change, no parent revival — and the restart-recovery path for a cancelled subagent is closed as well.

For the exact per-file diff, see **[PATCHES.md](./PATCHES.md)**: the canonical combined diff [`patches/v2.0.27.patch`](./patches/v2.0.27.patch) (all **35** changed files of the current build), and the per-fix breakdown across `0001`–`0006` (the `0001` sidebar-gate removal, the `0002` waiting-status/tick fix, the `0003` inline-steer-composer change and its test, the `0004` waiting-abort change and its test, the `0005` foreground-only-interrupt change and its tests, and the `0006` non-reviving-cancellation change and its tests) — before/after hunks, grouping, and how to apply them to a clean checkout.

---

## Patch files

The **combined** diff is the canonical way to reproduce the current build; the
six numbered files are the historical per-fix breakdown of the same changes.

| Patch | Contents |
|-------|----------|
| `patches/v2.0.27.patch` | **Canonical combined diff** — `git diff v2.0.27 patched-2.0.27`: all **35** changed files (+1049/−79) of the current patched tree. Apply to a clean **v2.0.27** checkout to reproduce the build byte-for-byte (verified tree `287e2f0c6ea5bef8f3cff6d66e8700d23e055462`). |
| `patches/0001-remove-parentid-sidebar-gate.patch` | Removes the `parentID` sidebar gate in `packages/tui/src/component/session-frame.tsx`. |
| `patches/0002-session-waiting-status-tick-fix.patch` | The waiting-status feature and completion-tick fix across schema/client/core/app/tui/plugin, plus tests (19 files). |
| `patches/0003-child-composer-steer.patch` | Makes a child session's host composer the inline steer composer (render the host `Prompt` instead of force-opening the subagent picker), makes the composer's agent type follow the viewed child's own agent, and gives the composer a distinct blue palette while viewing a subagent, plus a regression test (`packages/tui/src/routes/session/index.tsx`, `packages/tui/src/context/local.tsx`, `packages/tui/src/app.tsx`, `packages/tui/src/component/prompt/index.tsx`, `packages/tui/test/child-composer-steer.test.tsx`). |
| `patches/0004-abort-waiting-session.patch` | Makes aborting a `waiting` session (one whose turn settled with outstanding durable background work and so has no live execution) cancel that background work, clear its durable recovery marker, and publish the interrupted terminal, plus a regression test (`packages/core/src/session/execution.ts`, `packages/core/test/session-execution.test.ts`). `0005` makes this cancellation opt-in via `cancelBackground: true`. |
| `patches/0005-interrupt-foreground-only.patch` | Adds `cancelBackground` (default `false`) to `session.interrupt`, making the default interrupt **foreground-only**: a live foreground turn stops but the session's durable background jobs keep running, and interrupting a `waiting` session is a no-op. `cancelBackground: true` restores the full-stop behavior; `Session.remove` and the inactivity reaper opt in. Touches `packages/protocol`, `packages/server`, `packages/core` (`session.ts`, `session/execution.ts`, `session/session.ts`, `location-activity.ts`), the four generated client files, and three core tests. |
| `patches/0006-abort-does-not-resume.patch` | Makes a **cancelled** job's/subagent's notice non-reviving: `resume: false` when `status === "cancelled"` in `packages/core/src/tool/plugin/shell.ts` (`notifyWhenDone`) and `packages/core/src/session/subagent-completion.ts` (`deliver`). Cancellation is still admitted for context, but it no longer wakes the owner into a new turn; normal `succeeded`/`failed`/`error` completions still resume. Touches only `packages/core` (two sources + two tests). |

The six numbered patches are the per-fix breakdown of the same changes. Applying them **in order** to a clean upstream **v2.0.27** checkout is **not fully automatic**: two hunks need a hand-merge and one type-only test adaptation (`packages/client/src/solid/data.ts`, `packages/core/src/session/subagent-job.ts`, and `packages/core/test/location-activity.test.ts`), and `0005` must be applied **after** `0002` and `0004` (it references text they introduce). Use plain `git apply` (not `--3way`) in a checkout with `core.autocrlf=true`. For a byte-exact reproduction, prefer the combined `patches/v2.0.27.patch` above. See [PATCHES.md](./PATCHES.md) for the exact `git apply` commands, the port notes, and the verified tree hashes.

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
$env:OPENCODE_VERSION="2.0.27-patched"; $env:OPENCODE_CHANNEL="prod"
bun --bun ./script/build.ts --single --skip-install
# => packages/cli/dist/cli-windows-x64/bin/opencode.exe
```
