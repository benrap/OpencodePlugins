# opencode-patched

Runnable **Windows x64**, **Linux x64**, and **Linux arm64** builds of OpenCode based on upstream v2.1.4 (tag `v2.1.4`, commit `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`), plus a five-patch set that adds a session **waiting** status, removes the subagent sidebar gate, adds an inline steer composer for child sessions, makes the default interrupt **foreground-only**, and makes abort terminate cleanly (a cancelled job no longer revives its owner, and a parked `waiting` owner settles instead of staying stuck).

---

## How to run it (TL;DR)

1. **Prebuilt binary (simplest)** — download the `patched-v2.1.4` asset for your platform below: the Windows zip (`opencode.exe`) or a Linux tarball (`tar -xzf` → `chmod +x ./opencode`), then run it from that folder.
2. **PATH shim (Windows)** — if you already use the `%USERPROFILE%\.opencode-patched\opencode.cmd` shim, **quit every running `opencode` process and relaunch**; `opencode` then resolves to the patched build. If the shim directory is missing from your `PATH`, re-run `scripts\switch-patched.ps1` (see [Install into PATH](#install-into-path-optional-windows)).
3. **Build from source** — see [Build from source](#build-from-source-optional).

**Confirm which build you are on:** `opencode --version` → `opencode v2.1.4-patched`.

**Roll back:** install the previous **`patched-v2.0.27`** release (or the older **`patched-v2.0.23`**), or run `scripts\revert-patched.ps1` to remove the shim from `PATH` and return to stock `opencode`.

---

## Download & run (Windows x64, Linux x64, Linux arm64)

No `bun`, no `node`, and no source tree are required — every asset contains a
self-contained binary.

### Windows x64

**Direct download:**

<https://github.com/benrap/OpencodePlugins/releases/download/patched-v2.1.4/opencode-patched-windows-x64.zip>

**Steps:**

1. Download `opencode-patched-windows-x64.zip` from the link above.
2. Unzip it to a folder of your choice. The zip contains a single self-contained `opencode.exe` at its root.
3. Run `opencode.exe` from that folder.
   - Optionally, add the folder to your `PATH` so you can run `opencode` from anywhere (see [Install into PATH](#install-into-path-optional-windows)).

### Linux x64 / arm64

**Direct downloads:**

- x64: <https://github.com/benrap/OpencodePlugins/releases/download/patched-v2.1.4/opencode-patched-linux-x64.tar.gz>
- arm64: <https://github.com/benrap/OpencodePlugins/releases/download/patched-v2.1.4/opencode-patched-linux-arm64.tar.gz>

**Requirements:** a glibc-based `x86_64` (ELF `e_machine` `0x3E`) or `aarch64`
(ELF `e_machine` `0xB7`) Linux host. The **x64** build is runtime-tested on
Ubuntu 24.04 LTS (glibc 2.39); the **arm64** build is cross-compiled and
statically verified only (ELF `e_machine` `0xB7` plus the embedded patch and
version markers) because the build host has no arm64 runtime. The binaries are
dynamically linked against glibc — **no musl or baseline builds are published** —
and need nothing beyond glibc at runtime.

**Steps:**

1. Download the tarball matching your architecture from the links above.
2. Extract it: `tar -xzf opencode-patched-linux-x64.tar.gz` (arm64: `tar -xzf opencode-patched-linux-arm64.tar.gz`). Each archive holds a single root entry, `opencode`.
3. `chmod +x opencode` — GNU tar already restores mode 755, so this is only needed if your extractor dropped the executable bit.
4. Confirm the build: `./opencode --version` → `opencode v2.1.4-patched`.

**Linux assets:**

| Artifact | Size | SHA-256 |
|---|---:|---|
| `opencode-patched-linux-x64.tar.gz` | 114,400,216 B | `00711962E783FCDEA7803A76B7422EF2CB7A14AD87339405501F7A42D2513974` |
| `opencode-patched-linux-arm64.tar.gz` | 113,093,527 B | `A0D78313696FCE0A13078E4E0E1F8CB4E5C775A70E11B09D07E4F1FA569C4367` |

Verify the download against the table (digests are shown uppercase; `sha256sum`
prints lowercase, and hex case is ignored):

```bash
sha256sum opencode-patched-linux-*.tar.gz
```

The extracted `opencode` binary is 240,408,752 B on x64 and 236,112,888 B on
arm64.

> **Note:** the prebuilt assets above — the Windows zip, and the Linux x64 and
> Linux arm64 tarballs — are all the **`patched-v2.1.4`** release, built from
> the upstream v2.1.4 base. The previous **`patched-v2.0.27`** release remains
> available for rollback, and **`patched-v2.0.23`** is older history. To reproduce
> the current build from source, apply
> [`patches/v2.1.4.patch`](./patches/v2.1.4.patch) to a clean v2.1.4 checkout (or
> build from source, below).

**Notes:**

- On first use of `grep`/`glob`, OpenCode may download `ripgrep` automatically. This is standard OpenCode behavior; everything else in the bundle is self-contained.
- The Windows binary is **unsigned**, so Windows SmartScreen may show a warning. Choose "More info" → "Run anyway" if you trust this build.
- The Linux binaries are **unsigned** too: no distro packages, no signing or notarization step. Some browsers may warn on download; check the SHA-256 above.

---

## What this is

This is patched OpenCode built from upstream **v2.1.4** with the changes documented in [PATCHES.md](./PATCHES.md). In short:

- A **waiting** session status: while a turn's durable background work (shell jobs, nested subagents) is still outstanding, `Execution.Succeeded` is withheld and the session reports `waiting` instead of flashing a spurious "done" tick. Subagent finalization also waits for the child's pending background notifications before completing, so a child with outstanding durable work is not finalized early.
- The TUI treats `waiting` as busy (running), shows a "waiting for background work…" indicator, and does not render the completion tick until the work truly finishes.
- The **subagent sidebar gate** is removed, so child/subagent sessions render in the sidebar tree regardless of their `parentID`.
- **Inline steer composer for child/subagent sessions.** Viewing a child session now renders the normal host message composer; typing in it submits the text to the viewed child as a **steer** prompt (the host `Prompt` already defaults `delivery` to `"steer"` and targets its `sessionID`). The composer's **agent type** reflects that subagent's own agent (not the main agent's), and the whole composer box uses a distinct **blue palette**, so the steer is associated with the right agent type and it is obvious who is being spoken to. The subagent picker is no longer force-opened for children — it stays reachable via the "Toggle subagent picker" command (`session.child.first`, default `down`). Main-session behavior is unchanged.
- **`session.interrupt` takes `cancelBackground` (default `false`).** The default interrupt is **foreground-only**: it stops the live foreground turn but leaves the session's durable background jobs alone, and interrupting a `waiting` session (which has no active foreground execution) is a **no-op**. Passing `cancelBackground: true` restores the full-stop behavior — cancel outstanding background jobs, including aborting a `waiting` session. `Session.remove` passes `true`, so removing a session still tears down its durable work. This is what `Esc Esc` needs: stop the agent in front of you without touching background tasks.
  > **v2.1.4 note:** upstream redesigned the inactivity reaper (PR #57416) so it no longer interrupts sessions. The old reaper hunk from the v2.0.27 patch set is therefore **intentionally not ported**. Internal opt-ins are `Session.remove`, the app/TUI revert paths, and blocking-subagent teardown.
- **Aborting a subagent stops it cleanly — no new turn.** A cancelled background job or subagent still admits its terminal notice into the owner's context, but the notice now carries `resume: false` when `status === "cancelled"` (in `tool/plugin/shell.ts` `notifyWhenDone` and `session/subagent-completion.ts` `deliver`). Previously that notice was delivered with the default `resume: true`, so aborting a subagent woke the aborted session into a brand-new model turn (the subagent "dealt with the abortion") and revived the parent too. Now only `succeeded`/`failed`/`error` completions resume the owner, so an abort terminates the subagent cleanly — no follow-up turn, no focus change, no parent revival — and the restart-recovery path for a cancelled subagent is closed as well. When that cancelled notice clears the owner's **last** durable background marker, `SessionExecution.settleWaitingIfIdle` publishes exactly one interrupted terminal and releases the owner's claim, so a parent parked in `waiting` returns to idle instead of staying stuck (a default interrupt is a no-op there, and `cancelBackground` previously had no pending marker left to cancel). The same settle runs for a cancelled background shell job and from the no-pending-marker branch of a background-cancelling interrupt; revert and blocking-subagent teardown now opt into `cancelBackground` so they stop the work they are abandoning.

For the exact per-file diff, see **[PATCHES.md](./PATCHES.md)**: the canonical combined diff [`patches/v2.1.4.patch`](./patches/v2.1.4.patch) of the current build, plus the per-fix breakdown across `0001`–`0005` — before/after hunks, grouping, and how to apply them to a clean checkout.

**Diffstat:** 45 files changed, +1324/−86 (`patches/v2.1.4.patch`); verified patched tree `48c4c4ecb9c3880718c8fc4aebee89fd77b7f167` (`48c4c4ec`).

---

## Patch files

The **combined** diff is the canonical way to reproduce the current build; the
five numbered files are the per-fix breakdown of the same changes.

| Patch | Contents |
|-------|----------|
| `patches/v2.1.4.patch` | **Canonical combined diff** — the complete change set of the current patched tree. Apply to a clean **v2.1.4** checkout to reproduce the build. |
| `patches/0001-remove-parentid-sidebar-gate.patch` | Removes the `parentID` sidebar gate in `packages/tui/src/component/session-frame.tsx`. |
| `patches/0002-session-waiting-status-tick-fix.patch` | The waiting-status feature and completion-tick fix across schema/client/core/app/tui/plugin, plus tests. Includes subagent finalization waiting for the child's pending background notifications. |
| `patches/0003-child-composer-steer.patch` | Makes a child session's host composer the inline steer composer (render the host `Prompt` instead of force-opening the subagent picker), makes the composer's agent type follow the viewed child's own agent, and gives the composer a distinct blue palette while viewing a subagent, plus a regression test (`packages/tui/src/routes/session/index.tsx`, `packages/tui/src/context/local.tsx`, `packages/tui/src/app.tsx`, `packages/tui/src/component/prompt/index.tsx`, `packages/tui/test/child-composer-steer.test.tsx`). |
| `patches/0004-cancel-background-interrupt.patch` | Adds `cancelBackground` (default `false`) to `session.interrupt`, making the default interrupt **foreground-only**, and folds in abort of a `waiting` session: with `cancelBackground: true`, outstanding durable background work is cancelled (clearing the durable recovery marker and publishing the interrupted terminal), so a waiting session actually stops. Interrupting a waiting session without the flag is a no-op. `Session.remove` passes `true`. Touches `packages/protocol`, `packages/server`, `packages/core` (`session.ts`, `session/execution.ts`, `session/session.ts`), the generated client files, and core tests. The old v2.0.27 `location-activity.ts` reaper hunk is obsolete upstream and intentionally omitted. |
| `patches/0005-abort-does-not-resume.patch` | Keeps a **cancelled** job's/subagent's notice non-reviving (`resume: false` when `status === "cancelled"` in `packages/core/src/tool/plugin/shell.ts` `notifyWhenDone` and `packages/core/src/session/subagent-completion.ts` `deliver`), and adds `settleWaitingIfIdle`: when that notice clears the owner's last durable background marker, the owner parked in `waiting` gets exactly one interrupted terminal with its claim released, without starting a turn. It also settles a waiting session with no markers on a `cancelBackground` interrupt, and opts blocking-subagent teardown plus app/TUI revert into `cancelBackground: true`. Touches 18 files across `packages/app`, `packages/core`, `packages/server`, and `packages/tui` (sources and tests). |

The combined `patches/v2.1.4.patch` is canonical and applies cleanly to a clean
upstream **v2.1.4** checkout. The five numbered patches are the per-fix breakdown
of the same changes and apply **in order**; use plain `git apply` (not `--3way`)
in a checkout with `core.autocrlf=true`. See [PATCHES.md](./PATCHES.md) for the
exact `git apply` commands and the current patch contents.

---

## Install into PATH (optional, Windows)

On Windows, the `scripts/` folder contains helpers that point a command on your `PATH` at the patched standalone binary:

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

**Linux:** the PowerShell helpers above and the generated `opencode.cmd` do not
apply. Move or link the extracted binary somewhere on your `PATH` instead:

```bash
install -m 755 opencode ~/.local/bin/opencode
```

`~/.local/bin` is on `PATH` by default on most distributions; otherwise add it to
your shell profile, or install to `/usr/local/bin` with `sudo install -m 755 opencode /usr/local/bin/opencode`.

---

## Build from source (optional)

If you would rather build the binaries yourself from the patched source tree:

**Windows x64:**

```powershell
cd packages/cli
$env:OPENCODE_VERSION="2.1.4-patched"; $env:OPENCODE_CHANNEL="prod"
bun --bun ./script/build.ts --target=opencode-windows-x64 --skip-install
# => packages/cli/dist/cli-windows-x64/bin/opencode.exe
```

**Linux x64 / arm64:**

```bash
cd packages/cli
export OPENCODE_VERSION="2.1.4-patched" OPENCODE_CHANNEL="prod"

bun --bun ./script/build.ts --target=opencode-linux-x64
# => packages/cli/dist/cli-linux-x64/bin/opencode

bun --bun ./script/build.ts --target=opencode-linux-arm64
# => packages/cli/dist/cli-linux-arm64/bin/opencode
```

Both Linux binaries are glibc (gnu) builds; the `linux-arm64` target cross-compiles
on an x86_64 host.

**Native dependencies.** The `--skip-install` flag in the Windows recipe is only
safe once the target's native packages are present. A fresh clone needs them, so
either omit `--skip-install` for the first build of a target (the script then
runs `bun install --os="*" --cpu="*" --libc="*"` so the target native packages
are installed) or run `bun install` first. After that, `--skip-install` is fine.

The build requires **bun 1.4.4** (the version pinned by the root
`packageManager` field).
