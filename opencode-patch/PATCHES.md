# PATCHES — patched OpenCode on upstream v2.1.4

This document describes the patch set that turns a pristine upstream **v2.1.4**
checkout into the tree this repository builds and ships as **`v2.1.4-patched`**.

- **Base:** upstream tag `v2.1.4`, commit `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`.
- **Five numbered patches**, applied in order `0001` → `0005`, plus one
  **canonical combined diff**, `patches/v2.1.4.patch`, which is the same change
  set in a single file.
- **Canonical combined diff:** 45 files changed, **+1324 / −86**.
- **Verified patched tree:** `48c4c4ecb9c3880718c8fc4aebee89fd77b7f167`
  (`48c4c4ec`), produced both by applying `0001`–`0005` in order and by applying
  `v2.1.4.patch` alone to a pristine v2.1.4 worktree.

| Artifact | Size |
|---|---:|
| `patches/0001-remove-parentid-sidebar-gate.patch` | 1,731 B |
| `patches/0002-session-waiting-status-tick-fix.patch` | 33,694 B |
| `patches/0003-child-composer-steer.patch` | 17,943 B |
| `patches/0004-cancel-background-interrupt.patch` | 29,042 B |
| `patches/0005-abort-does-not-resume.patch` | 38,979 B |
| `patches/v2.1.4.patch` (combined) | 112,172 B |

---

## Behavioral summary

### 0001 — remove the `parentID` sidebar gate

`packages/tui/src/component/session-frame.tsx` no longer hides the sidebar for a
session with a `parentID`, so child/subagent sessions render in the sidebar tree.

### 0002 — `waiting` status and the completion-tick fix

While durable background work is outstanding, the core withholds
`Execution.Succeeded` and publishes `session.status` `{ type: "waiting" }`.
Clients keep the session busy and do not render the completion tick.

- The TUI renders `waiting for background work…`; session tabs treat any
  non-idle status as busy; a subagent tool part stays “running” while its child
  is waiting; the app model maps waiting to `{ type: "waiting" }`.
- The app/client/plugin status types gain `waiting`.
- `SubagentCompletion.finalText` runs a child to quiescence: it resumes, checks
  for pending durable work, waits for acknowledgment, repeats, and only then
  reads the final completed response. Subagent completion and restart recovery
  use it instead of finalizing early.
- **The execution claim is kept while waiting** (a deliberate v2.1.4 change; the
  v2.0.27 patch released it). The turn is still in flight, not abandoned, and
  the boot sweep resumes it after recovering durable background markers.
- A parked (waiting) session has no execution fiber whose settled hook could
  later publish a terminal. `0002` creates that state; `0005` adds the settle
  path that finishes it when its last marker disappears.

### 0003 — inline steer composer for child sessions

Viewing a child/subagent session renders the normal host `Prompt` instead of
force-opening the subagent picker and rendering `null`.

- Text submits to the viewed child with the host prompt's default delivery
  `"steer"`.
- The composer's agent type follows the **viewed child's own agent** (often a
  `mode: "subagent"` agent absent from the primary list), and only that agent is
  selectable while viewing the child, so submitting a steer does not switch the
  child's agent.
- The composer uses a distinct **blue palette** (background 0.4, border 0.9,
  placeholder 0.6 alpha over the theme tokens) and the placeholder
  `"Steer this subagent…"`.
- The subagent picker remains available via `session.child.first`
  (“Toggle subagent picker”, default `down`), which now toggles on a child
  instead of always closing.
- Main-session behavior is unchanged.

### 0004 — `cancelBackground` / foreground-only interrupt

`session.interrupt` gains `cancelBackground` (protocol query, server handler,
generated clients, core API), **default `false`**.

- Default interrupt is **foreground-only**: stop a live foreground turn but leave
  durable background jobs running. Interrupting a waiting session (no active
  execution) is a no-op.
- `cancelBackground: true` cancels the session's outstanding durable jobs,
  acknowledges their markers, interrupts subagent children, and settles a
  waiting session with `Execution.Interrupted`.
- `Session.remove` passes `true`, so removing a session tears down its durable
  work.
- The old `location-activity.ts` reaper hunk is **obsolete and not ported**:
  upstream v2.1.2 (PR #57416) redesigned the reaper to retain locations with
  active executions or running background jobs.

### 0005 — non-reviving cancellation and parked-owner settlement

This patch carries the old non-reviving-cancellation behavior and the fix for
the case where that behavior stranded a parent in `waiting`.

- **Cancelled notices do not revive.** `SubagentCompletion.deliver` and shell
  `notifyWhenDone` admit a cancelled notice with `resume: false`. Real
  completions/failures still resume the owner; restart recovery for a cancelled
  subagent stays closed.
- **Stuck-`waiting` fix.** A parent turn parked in `waiting` has no execution
  whose settled hook can publish its terminal. Before this fix, a cancelled
  notice that cleared the last durable marker removed the marker but left the
  parent `waiting` with the claim held forever: a default interrupt is a no-op,
  and `cancelBackground: true` did nothing because `pending.length === 0`.
- `SessionExecution` now keeps a process-local `waiting` set (added when
  publishing waiting; removed on a fresh `started` and on every terminal), and
  exposes `settleWaitingIfIdle(sessionID)`. It returns false unless the session
  is parked, not active, and has no pending background markers; otherwise it
  publishes exactly one `Execution.Interrupted` (reason `"user"`) with
  `releaseOnCommit` and returns the session to idle **without starting a turn**.
- `SubagentCompletion.deliver` calls it after `completeBackground` for a
  cancelled notice; shell `notifyWhenDone` does the same for a cancelled
  background shell.
- The parked `cancelBackground` interrupt branch now handles
  `pending.length === 0` by calling the same settle. A plain interrupt with
  real pending work remains a no-op.
- **Audit fixes:** blocking-subagent teardown interrupts the abandoned child
  with `{ cancelBackground: true }`; app and TUI revert also pass it, so
  reverting a parked session stops and settles its work instead of leaving
  stale `waiting` state.
- `Session` exposes the settle operation so notice-delivery paths can reach it;
  test fakes implement it.

---

## Patch layout

File counts are **entries per patch** (`^diff --git`), not distinct repository
files; later patches overlap earlier ones.

| Patch | Focus | Files | Diff | Bytes |
|---|---|---:|---:|---:|
| `0001` | Sidebar `parentID` gate | 1 | +0 / −3 | 1,731 |
| `0002` | `waiting` status / tick fix | 21 | +373 / −30 | 33,694 |
| `0003` | Child inline steer composer | 5 | +237 / −15 | 17,943 |
| `0004` | `cancelBackground` / foreground-only interrupt | 12 | +331 / −21 | 29,042 |
| `0005` | Non-reviving cancellation + parked-owner settlement | 18 | +383 / −17 | 38,979 |
| **Sum of entries** | | **57** | **+1324 / −86** | |
| **Combined / distinct** | | **45** | **+1324 / −86** | 112,172 |

`57 − 45 = 12` extra entries. Nine files appear in more than one patch:
`execution.ts`, `session-execution.test.ts`, and `routes/session/index.tsx` in
three each; `session.ts`, `session-remove.test.ts`, `subagent-completion.ts`,
`prompt/index.tsx`, generated `types.ts`, and `tool-subagent.test.ts` in two.

### Files by patch

- **0001 (1):** `packages/tui/src/component/session-frame.tsx`
- **0002 (21):** `packages/app/src/composer/submit.test.ts`,
  `app/src/session/model.ts`, `app/src/session/requests/background.ts`,
  `app/src/shell/routes/session-ui-provider.tsx`,
  `client/src/promise/generated/types.ts`, `client/src/solid/data.ts`,
  `client/test/solid-data.test.ts`, `core/src/job.ts`,
  `core/src/session/execution.ts`, `core/src/session/execution/restart.ts`,
  `core/src/session/subagent-completion.ts`, `core/src/session/subagent-job.ts`,
  `core/test/job.test.ts`, `core/test/session-execution.test.ts`,
  `core/test/tool-subagent.test.ts`, `plugin/src/tui/context.ts`,
  `schema/src/session-status-event.ts`, `tui/src/component/prompt/index.tsx`,
  `tui/src/context/session-tabs.tsx`, `tui/src/routes/session/index.tsx`,
  `tui/test/context/session-tabs.test.tsx`
- **0003 (5):** `tui/src/app.tsx`, `tui/src/component/prompt/index.tsx`,
  `tui/src/context/local.tsx`, `tui/src/routes/session/index.tsx`,
  `tui/test/child-composer-steer.test.tsx` (new)
- **0004 (12):** `client/src/effect/api/api.ts`,
  `client/src/effect/generated/client.ts`,
  `client/src/promise/generated/client.ts`,
  `client/src/promise/generated/types.ts`, `core/src/session.ts`,
  `core/src/session/execution.ts`, `core/src/session/session.ts`,
  `core/test/session-execution.test.ts`, `core/test/session-remove.test.ts`,
  `protocol/openapi.json`, `protocol/src/groups/session.ts`,
  `server/src/handlers/session.ts`
- **0005 (18):** `app/src/session/revert.ts`, `core/src/session.ts`,
  `core/src/session/execution.ts`, `core/src/session/subagent-completion.ts`,
  `core/src/tool/plugin/shell.ts`, `core/src/tool/plugin/subagent.ts`,
  `core/test/session-execution.test.ts`, `core/test/session-owned.test.ts`,
  `core/test/session-prompt.test.ts`, `core/test/session-remove.test.ts`,
  `core/test/session-runner-recorded.test.ts`, `core/test/session-runner.test.ts`,
  `core/test/session-shell.test.ts`, `core/test/subagent-lifetime.test.ts`,
  `core/test/tool-shell.test.ts`, `core/test/tool-subagent.test.ts`,
  `server/test/session-diff.test.ts`, `tui/src/routes/session/index.tsx`

All paths above are under `packages/`.

### Key code changes

**Waiting publication (`0002`, `core/src/session/execution.ts`)**

```ts
if (outcome.type === "succeeded") {
  if (yield* jobs.awaiting(sessionID)) {
    yield* bus.publish(SessionStatusEvent.Status, { sessionID, status: { type: "waiting" } })
    return
  }
  yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, releaseOnCommit(sessionID))
}
```

**Settle primitive (`0005`, `core/src/session/execution.ts`)**

```ts
const settleWaitingIfIdle = (sessionID) =>
  Effect.gen(function* () {
    if (!waiting.has(sessionID)) return false
    if (yield* coordinator.isActive(sessionID)) return false
    if (yield* jobs.awaiting(sessionID)) return false
    waiting.delete(sessionID)
    yield* bus.publish(
      SessionEvent.Execution.Interrupted,
      { sessionID, reason: "user" },
      releaseOnCommit(sessionID),
    )
    return true
  })
```

`waiting.add(sessionID)` runs in the waiting branch; `waiting.delete` runs on a
fresh `started` execution and on every terminal (`succeeded`, `interrupted`,
`failed`), and in the parked interrupt branch.

**Non-reviving notice plus settle (`0005`,
`core/src/session/subagent-completion.ts`)**

```ts
...(input.resume === false || input.status === "cancelled" ? { resume: false } : {}),
...
if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
if (input.status === "cancelled") yield* sessions.settleWaitingIfIdle(recovery.parentSessionID)
```

Shell `notifyWhenDone` mirrors this after `completeBackground`.

**Parked interrupt (`0005`, `core/src/session/execution.ts`)**

```ts
if (pending.length > 0) {
  // cancel the jobs, interrupt subagent children, acknowledge markers,
  // delete from `waiting`, publish Interrupted
  handled = true
} else if (yield* settleWaitingIfIdle(sessionID)) {
  handled = true
}
```

A plain `interrupt(sessionID)` (no `cancelBackground`) never enters this branch
and remains a no-op for a parked session.

### Tests

- `core/test/session-execution.test.ts`
  - “settles a waiting parent when a cancelled child clears its last marker”:
    exactly one `Interrupted`, no `Succeeded`/`Failed`, `jobs.awaiting` false,
    claim released, no second `started` (no new turn).
  - “settles a Waiting Session with no pending markers on a
    background-cancelling interrupt”: plain interrupt is `false` with no
    terminal; `cancelBackground: true` is `true`, publishes one terminal, and
    releases the claim.
  - Existing waiting/interrupt/cancellation tests were extended; the waiting
    test asserts the claim stays held until the terminal.
- `core/test/tool-shell.test.ts`: a cancelled shell is admitted without waking
  the owner and asks it to settle; a completed shell still wakes the owner.
- `core/test/subagent-lifetime.test.ts`: a cancelled notice stays pending with
  no second LLM request.
- `core/test/job.test.ts`: only acknowledgment releases `awaitBackground`.
- `tui/test/child-composer-steer.test.tsx` (new) and
  `tui/test/context/session-tabs.test.tsx`: child composer/agent/palette/picker
  and waiting-as-busy coverage.

---

## How to apply

Use plain `git apply` (no `--3way`) on a clean v2.1.4 checkout at
`68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`.

### Combined (recommended)

```bash
git clone https://github.com/anomalyco/opencode opencode-verify
cd opencode-verify
git checkout 68bc26b7da1990ce10ffecfbc1e09eb13aa5d824   # tag v2.1.4
git apply /path/to/patches/v2.1.4.patch
```

All 45 files apply with no rejects; the tree matches
`48c4c4ecb9c3880718c8fc4aebee89fd77b7f167`.

### Numbered patches, in order

```bash
git checkout 68bc26b7da1990ce10ffecfbc1e09eb13aa5d824   # tag v2.1.4
git apply /path/to/patches/0001-remove-parentid-sidebar-gate.patch
git apply /path/to/patches/0002-session-waiting-status-tick-fix.patch
git apply /path/to/patches/0003-child-composer-steer.patch
git apply /path/to/patches/0004-cancel-background-interrupt.patch
git apply /path/to/patches/0005-abort-does-not-resume.patch
```

- `0004` must follow `0002` (it builds on the waiting status and the
  `awaiting`/`pendingFor`/`completeBackground` operations).
- `0005` must follow `0002`–`0004` (it uses `cancelBackground`, the waiting set,
  and the session facade).
- `0003` is TUI-only and independent of `0004`/`0005`.
- Every patch passed `git apply --check` (exit 0) and applied with exit 0.

---

## Verification

**Apply/tree.** `git apply --check` and `git apply` exited 0 for `0001`–`0005`
individually and for `v2.1.4.patch`. Intermediate trees:
`e4c80cf1` → `0fbf242a` → `d4c0c85f` → `d498adc0` → `48c4c4ec`. Both the
ordered set and the combined patch produce
`48c4c4ecb9c3880718c8fc4aebee89fd77b7f167`, identical to the patched build tree.

**Build** (bun 1.4.4):

```powershell
cd packages/cli
$env:OPENCODE_VERSION="2.1.4-patched"; $env:OPENCODE_CHANNEL="prod"
bun --bun ./script/build.ts --target=opencode-windows-x64 --skip-install
```

```bash
cd packages/cli
export OPENCODE_VERSION="2.1.4-patched" OPENCODE_CHANNEL="prod"
bun --bun ./script/build.ts --target=opencode-linux-x64
# => packages/cli/dist/cli-linux-x64/bin/opencode
bun --bun ./script/build.ts --target=opencode-linux-arm64
# => packages/cli/dist/cli-linux-arm64/bin/opencode
```

| Artifact | Size | SHA-256 |
|---|---:|---|
| `opencode.exe` | 246,889,984 B | `AF75E3FD0C3DD131C2C0E58EEEFFACB03A8AAE0F214987D5625D7536BF887D4F` |
| `opencode-patched-windows-x64.zip` | 117,157,757 B | `53E667ACD5D5625ACDCF37B6CB5F418CF9412880B2E8760D4F40981B0F9C9E34` |
| `opencode-patched-linux-x64.tar.gz` | 114,400,216 B | `00711962E783FCDEA7803A76B7422EF2CB7A14AD87339405501F7A42D2513974` |
| `opencode-patched-linux-arm64.tar.gz` | 113,093,527 B | `A0D78313696FCE0A13078E4E0E1F8CB4E5C775A70E11B09D07E4F1FA569C4367` |

The zip contains exactly one root entry, `opencode.exe` (246,889,984 B). Each
Linux tarball also contains exactly one entry, `opencode` (`-rwxr-xr-x`, mode
755, preserved by GNU tar): 240,408,752 B on x64 and 236,112,888 B on arm64.
`opencode.exe --version` prints `opencode v2.1.4-patched` and `--help` exits 0;
the Linux x64 binary prints `opencode v2.1.4-patched` and `--help` exits 0 when
run on Ubuntu 24.04. The Linux arm64 binary is cross-compiled on x86_64 and was
verified statically only (ELF `e_machine` `0xB7`, the four patch markers and
the `2.1.4-patched` version constant present) — it was not executed on this
host.

**Runtime verification (Linux x64, Ubuntu 24.04 LTS / glibc 2.39, WSL).** The
extracted binary reports `opencode v2.1.4-patched` for `--version` (exit 0) and
`--help` exits 0. `serve --port 4099` came up and was reachable: `GET /api/info`
requires HTTP Basic auth (user `opencode`, password printed in the serve log);
with credentials it returned `200` and JSON `{"version":"2.1.4-patched",...}`,
while unauthenticated requests returned `401` `application/json`
`{"_tag":"UnauthorizedError","message":"Authentication required"}`.
`GET /health` returned `200` with `text/html` (the SPA fallback on this build,
not JSON), with or without auth. The arm64 tarball is cross-compiled: its ELF
header (`e_machine` `0xB7`) and the four patch markers / `2.1.4-patched`
version constant were checked, but no arm64 runtime execution was performed.

**Focused tests (Windows, bun 1.4.4).**

| Suite | Result |
|---|---|
| `packages/core` focused run (6 files) | **124 pass / 63 skip / 0 fail** (187 tests) |
| `packages/tui` focused run | **29 pass / 0 fail** |
| `packages/client` focused run | **31 pass / 0 fail** |

Typechecks clean: core (1,636 files), TUI (1,686), schema, protocol, server,
client, plugin. The full suites still report pre-existing Windows environment
failures in files this patch set never touches (WSL/bash oracles, absent
`printf`, symlink `EPERM`, blocked ripgrep download, PTY, update banner); the
focused runs above are the meaningful signal.

**App typecheck caveat.** `packages/app/src/custom-elements.d.ts` is recorded as
a symlink (git mode `120000`) but is a 33-byte text file on Windows, so the app
typecheck fails on file resolution. A temporary external tsconfig typechecks
1,586 files cleanly. This is a checkout/platform artifact, not a patch defect.

---

## Known limitations

- **`waiting` is ephemeral.** It is a live projection derived from
  `session.status`, not durable session state; a reconnecting client may briefly
  show idle until the next execution event.
- **The parked-session set is process-local.** `settleWaitingIfIdle` fixes the
  in-process stuck-`waiting` case; restart recovery still relies on durable
  background markers and the execution claim, not the in-memory set.
- **`finalText` has no timeout.** It waits for every pending background
  notification to be acknowledged; a marker that is never acknowledged keeps a
  child's finalization pending by design.
- **A completed notice whose wake is suppressed by a staged revert** clears its
  marker without settling the parked owner; the session can show `waiting` until
  the next prompt, an undo-clear, or a restart. This is the same class as the
  settled cancelled-notice path and predates the port; revert callers now pass
  `cancelBackground: true` so the interrupt path settles it instead.
- **Double-settle window.** The parked-session set is a plain in-memory set; two
  concurrent settles are idempotent (one terminal plus a harmless duplicate
  release) but not formally serialized.
- **App symlink caveat** as above.

---

## Historical note

- The **`patched-v2.0.27`** and **`patched-v2.0.23`** releases remain available
  for rollback; they are built on the older v2.0.x base and are not
  patch-compatible with v2.1.4.
- **Linux assets first ship with `patched-v2.1.4`** (`opencode-patched-linux-x64.tar.gz`
  and `opencode-patched-linux-arm64.tar.gz`). The earlier `patched-v2.0.x`
  releases are Windows-only.
- In the v2.0.x set, what is now **0004** and **0005** were separate: the
  foreground-only `cancelBackground` interrupt and the waiting-session abort.
  They are merged into **0004** here.
- The old **0006** (non-reviving cancellation) was **renumbered to 0005** and
  extended with the settle-on-cancel fix and its teardown/revert audit fixes.
  There is no 0006 in the v2.1.4 set.
- The old `location-activity.ts` reaper hunk is not carried forward (upstream
  PR #57416; see 0004).
