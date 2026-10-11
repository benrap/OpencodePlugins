# PATCHES.md — `opencode-patched` vs upstream OpenCode v2.0.23

Exact, per-file record of what this patch set changes relative to upstream **v2.0.23**. Nothing here is aspirational: the hunks below are the actual patch contents, and `0001`+`0002` together reproduce the `c212f31561` rebased source tree byte-for-byte (verified tree hash below), with `0003`, `0004`, `0005`, and `0006` applying additively on top.

---

## Behavioral summary

What these patches actually do:

1. **Waiting status while background work is outstanding.** When a session's turn settles as "succeeded" but the session still owns outstanding durable background work (shell jobs it started, or a subagent awaiting its child), the core **withholds `SessionEvent.Execution.Succeeded`** and instead publishes a `session.status` event with `{ type: "waiting" }`. Clients therefore do not reduce the session to `idle`, so the completion tick does not appear. The terminal is emitted only once the background work is acknowledged and resumes/completes the turn.
2. **TUI treats `waiting` as running (busy).** The sidebar tab "busy" computation, the subagent running indicator, and the app session model all treat `waiting` as an active, non-idle status. The TUI shows a `waiting for background work…` line instead of a done tick.
3. **Sidebar gate removed.** `packages/tui/src/component/session-frame.tsx` no longer hides the sidebar for sessions with a `parentID`, so subagent/child sessions render in the sidebar tree.
4. **Abort can cancel pending background jobs (`cancelBackground`).** When a turn is interrupted with `cancelBackground: true`, the session's pending background jobs are cancelled in addition to the session job itself. `0005` refines this: the default interrupt is now **foreground-only**, so this job-cancellation only runs when `cancelBackground` is requested.
5. **Subagent background-completion fixes.** Subagent completion now runs the child to quiescence, waiting for its pending background notifications (`awaitBackground`) before finalizing the response, and restart recovery drains through the provided execution instance rather than the global `Session` service.
6. **Generated client types and schema** gain the `waiting` status member, and extensive tests cover the new behavior.
7. **Inline steer composer for child sessions** (`0003`). Viewing a child/subagent session now renders the normal host `<Prompt>` (the inline steer composer) instead of force-opening the `Composer` subagent picker and rendering `null`. The host `Prompt` submits to its own `props.sessionID` and defaults `delivery` to `"steer"`, so typed input is sent to the viewed child as a steer prompt. The composer's **agent type** also follows the viewed child's own agent (see `(c)`), so it neither displays the main agent's type nor switches the child's agent on submit, and the whole composer box uses a distinct **blue palette** while a subagent is being viewed. The picker stays reachable via `session.child.first` ("Toggle subagent picker", default `down`); main-session behavior is untouched.
8. **Aborting a `waiting` session now actually stops it** (`0004`). A session whose turn settled with outstanding durable background work sits in `waiting` with **no active execution** for the coordinator to interrupt, so an abort was previously a no-op. `SessionExecution.interrupt` now handles that case: when there is no live execution but the session still owns outstanding durable background work, it cancels that work, clears its durable recovery marker (so the session is no longer `awaiting`), and publishes the `session.execution.interrupted` terminal so clients leave `waiting`. A genuinely idle session (no outstanding background work) remains a `false` no-op. Effect: `/abort` and the child-composer Ctrl+D now genuinely stop a waiting subagent (its job's process scope is closed, which reaps the underlying shell process). Touches only `packages/core`; applies on top of `0001`–`0003` and is independent of the `0003` TUI change. `0005` then makes this waiting-branch cancellation **opt-in**: it now runs only when the interrupt is asked for with `cancelBackground: true`.
9. **`Esc Esc` is foreground-only; `cancelBackground` restores full-stop** (`0005`). `session.interrupt` gains an optional `cancelBackground` flag (default `false`). By default an interrupt now stops only the **foreground** turn: interrupting a live turn does **not** cancel the session's durable background jobs, and interrupting a `waiting` session (no active execution) is a **no-op**. This is what `Esc Esc` needs: the user asked to stop the agent in front of them, not to tear down unrelated background tasks. Passing `cancelBackground: true` restores the old `0002`/`0004` behavior — cancel the session's outstanding background jobs, including settling a `waiting` session with the interrupted terminal. Internal teardown callers that must not leave orphaned background work (`Session.remove`, and the inactivity reaper in `location-activity.ts`) now pass `cancelBackground: true` explicitly. Touches `packages/protocol`, `packages/server`, `packages/core` (`session.ts`, `session/execution.ts`, `session/session.ts`, `location-activity.ts`), the four generated client files, and three core tests; applies on top of `0001`–`0004` and contains no `packages/tui` hunks.
10. **A cancelled job's notice does not revive its owner** (`0006`). Cancelling a background job or a subagent still admits its terminal notice into the owner's context, but the notice now carries `resume: false` when `status === "cancelled"` — set in `tool/plugin/shell.ts` (`notifyWhenDone`) and `session/subagent-completion.ts` (`deliver`). Previously the notice was delivered with the default `resume: true`, so aborting a subagent woke the aborted session into a brand-new model turn (the subagent "dealt with the abortion") and likewise revived the parent. With `0006`, only `succeeded`/`failed`/`error` completions resume the owner; a cancellation is admitted for context but is non-reviving, so abort terminates cleanly — no follow-up turn, no focus change, no parent revival. It also closes the restart-recovery path, where a cancelled subagent's durable notice would otherwise resume the parent after a restart. Touches only `packages/core`; applies on top of `0001`–`0005`.

---

## Base, head, and commits

| | |
|---|---|
| **Base commit** | `0fd7e2829449b052abf0078666669302923d77af` (tag `v2.0.23`) |
| **Rebased head** | `c212f315615f2f6eeff6c706f54dd61153d6f5ba` (`c212f31561`) |
| **Diff size** | 20 files, 328 insertions(+), 36 deletions(-) |

The 7 commits on top of the base (newest first):

```
c212f31561 feat(tui): render the session sidebar for subagent sessions
6881028f87 fix(core): suppress the completion tick while a session is waiting
d8331680b9 fix(core): route subagent restart recovery through the provided execution
b26f96ae47 feat(tui): surface waiting session status
9f6748451a feat(core): publish waiting while background work is outstanding
5b5af22126 feat(schema): add waiting session status
14dea4c8a0 fix(core): await background notifications before finalizing subagent output
```

## Patch layout (verified file counts)

| Patch | Files | Contents |
|-------|-------|----------|
| `0001-remove-parentid-sidebar-gate.patch` | **1** | Sidebar gate removal in `session-frame.tsx` |
| `0002-session-waiting-status-tick-fix.patch` | **19** | Waiting status feature: schema/client/core/app/tui/plugin + tests |
| `0003-child-composer-steer.patch` | **5** | Child-session inline steer composer + agent type follows the viewed child + blue composer palette + regression test |
| `0004-abort-waiting-session.patch` | **2** | Abort of a `waiting` session cancels its outstanding durable background work and publishes the interrupted terminal (`packages/core` only) |
| `0005-interrupt-foreground-only.patch` | **13** | Foreground-only interrupt: `session.interrupt` gains `cancelBackground` (default `false`) in protocol/server/core + 4 generated client files + 3 core tests |
| `0006-abort-does-not-resume.patch` | **4** | Cancelled job/subagent notices are admitted with `resume: false`, so abort does not revive the owner (`packages/core` only) |
| **0001+0002 total** | **20** | Matches the `c212f31561` branch diff exactly |
| **0001+0002+0003 total** | **25** | Adds the inline steer composer, child agent type, and blue palette on top |
| **0001+0002+0003+0004 total** | **27** | Adds the waiting-session abort fix on top |
| **0001+0002+0003+0004+0005 total** | **40** | Adds the foreground-only interrupt on top (per-patch sum; `0005` overlaps a few `0002`/`0004` files — see the note) |
| **0001+0002+0003+0004+0005+0006 total** | **44** | Adds the non-reviving cancellation on top (per-patch sum; `0006` overlaps a few `0002`/`0005` files — see the note) |

> `0003` is **additive**: it is not part of the `c212f31561` waiting-status branch, so the tree-hash proof below still describes `0001+0002` only. `0003` applies cleanly on top of that tree and does not touch any file from `0001`/`0002`.

> `0004` is **additive** as well: it applies cleanly on top of `0001`–`0003`, touches only `packages/core` (never the `0003` TUI files), and is likewise **not** part of the `c212f31561` tree-hash proof below.

> `0005` is **additive** too: it applies cleanly on top of `0001`–`0004`, touches only `packages/protocol`, `packages/server`, `packages/core`, and the generated client (no `packages/tui` hunks, so it does not modify the `0003` TUI files), and is likewise **not** part of the `c212f31561` tree-hash proof below. Its 13 files overlap three earlier patches (`packages/core/src/session/execution.ts` also in `0002`/`0004`, `packages/client/src/promise/generated/types.ts` also in `0002`, and `packages/core/test/session-execution.test.ts` also in `0002`/`0004`), so the cumulative total above is the sum of per-patch counts, not a distinct-file count.

> `0006` is **additive** too: it applies cleanly on top of `0001`–`0005`, touches only `packages/core` (`session/subagent-completion.ts`, `tool/plugin/shell.ts`, and the tests `session-execution.test.ts` + `tool-shell.test.ts`), and is likewise **not** part of the `c212f31561` tree-hash proof below. Two of its files overlap earlier patches (`packages/core/src/session/subagent-completion.ts` also in `0002`, and `packages/core/test/session-execution.test.ts` also in `0002`/`0004`/`0005`), so the cumulative total above is the sum of per-patch counts, not a distinct-file count.

> **Scope & accuracy note:** An earlier README implied the patches covered the whole branch while they did in fact only cover part of it. The regenerated patch set now covers **all 20 files** in the branch diff: `0002` contains 19 files and `0001` contains the remaining 1. This is verified by counting `diff --git` headers and by the tree-hash check in "How to apply".

---

## (a) Sidebar gate removal

### `packages/tui/src/component/session-frame.tsx` — patch **0001**

**Hunk 1** — drop the now-unused import.

```
BEFORE
import { useConfig } from "../config"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"

AFTER
import { useConfig } from "../config"
import { Keymap } from "../context/keymap"
```

**Hunk 2** — drop the `data` handle that only the gate used.

```
BEFORE
  const config = useConfig()
  const data = useData()
  const toast = useToast()

AFTER
  const config = useConfig()
  const toast = useToast()
```

**Hunk 3** — remove the `parentID` gate from `sidebarVisible`.

```
BEFORE
  const sidebarVisible = createMemo(() => {
    if (data.session.get(props.sessionID)?.parentID) return false
    if (sidebarOpen()) return true
    return (config.data.session?.sidebar ?? "auto") === "auto" && wide()
  })

AFTER
  const sidebarVisible = createMemo(() => {
    if (sidebarOpen()) return true
    return (config.data.session?.sidebar ?? "auto") === "auto" && wide()
  })
```

**Rationale:** subagent/child sessions (`parentID != null`) previously never rendered their sidebar; removing the gate lets every session render the tree.

---

## (b) Waiting status feature

### `packages/schema/src/session-status-event.ts` — patch **0002**

```
BEFORE
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })

AFTER
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
  Schema.Struct({
    type: Schema.Literal("waiting"),
  }),
]).annotate({ identifier: "SessionStatus" })
```

**Rationale:** adds `waiting` to the wire-level session status union that clients subscribe to.

---

### `packages/core/src/job.ts` — patch **0002**

**Hunk 1** — track registered notification waiters in state.

```
BEFORE
type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

AFTER
type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  deliveries: SynchronizedRef.SynchronizedRef<Map<SessionMessage.ID, Deferred.Deferred<void>>>
  scope: Scope.Scope
}
```

**Hunk 2** — expose new interface operations.

```
BEFORE
  readonly completeBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
}

AFTER
  readonly completeBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
  readonly awaitBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
  readonly pendingFor: (sessionID: SessionSchema.ID) => Effect.Effect<readonly Background[]>
  readonly awaiting: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}
```

**Hunk 3** — initialize the deliveries map.

```
BEFORE
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }

AFTER
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    deliveries: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }
```

**Hunk 4** — add `pendingFor` / `awaiting` (appended after `pendingBackground`).

```
AFTER (added)
  /**
   * Outstanding durable background work owned by a Session: shell work belongs to the
   * Session that started it, subagent work belongs to the parent awaiting its child.
   */
  const pendingFor: Interface["pendingFor"] = Effect.fn("Job.pendingFor")(function* (sessionID) {
    return (yield* pendingBackground).filter((background) =>
      background.recovery.kind === "shell"
        ? background.recovery.sessionID === sessionID
        : background.recovery.parentSessionID === sessionID,
    )
  })

  const awaiting: Interface["awaiting"] = Effect.fn("Job.awaiting")(function* (sessionID) {
    return (yield* pendingFor(sessionID)).length > 0
  })
```

**Hunk 5** — `completeBackground` resolves a registered waiter after clearing the marker.

```
BEFORE
      Effect.gen(function* () {
        yield* kv.remove(`${backgroundPrefix}${notificationID}`)
        const entry = [...jobs].find(([, job]) => job.info.notificationID === notificationID)

AFTER
      Effect.gen(function* () {
        yield* kv.remove(`${backgroundPrefix}${notificationID}`)
        const waiter = yield* SynchronizedRef.modify(state.deliveries, (waiters) => {
          const deferred = waiters.get(notificationID)
          if (!deferred) return [undefined, waiters] as const
          const next = new Map(waiters)
          next.delete(notificationID)
          return [deferred, next] as const
        })
        if (waiter) yield* Deferred.succeed(waiter, undefined)
        const entry = [...jobs].find(([, job]) => job.info.notificationID === notificationID)
```

**Hunk 6** — add `awaitBackground` (appended after `completeBackground`).

```
AFTER (added)
  /**
   * Resolves once a durable background notification has been admitted, which is
   * when its marker clears. Waiting on the job itself only observes settlement;
   * the wake-up notification is admitted asynchronously after that.
   */
  const awaitBackground: Interface["awaitBackground"] = Effect.fn("Job.awaitBackground")(function* (notificationID) {
    const waiter = yield* SynchronizedRef.modifyEffect(
      state.deliveries,
      Effect.fnUntraced(function* (waiters) {
        // Marker read and waiter registration are atomic here; completeBackground
        // clears the marker before resolving, so no separate recheck is needed.
        if (!(yield* kv.get(`${backgroundPrefix}${notificationID}`))) return [undefined, waiters] as const
        const existing = waiters.get(notificationID)
        if (existing) return [existing, waiters] as const
        const deferred = Deferred.makeUnsafe<void>()
        return [deferred, new Map(waiters).set(notificationID, deferred)] as const
      }),
    )
    if (waiter) yield* Deferred.await(waiter)
  })
```

**Hunk 7** — register the new methods on the service.

```
BEFORE
    cancel,
    pendingBackground,
    completeBackground,
  })

AFTER
    cancel,
    pendingBackground,
    completeBackground,
    awaitBackground,
    pendingFor,
    awaiting,
  })
```

**Rationale:** gives the execution layer a way to ask "does this session still own background work?" and to block until a background notification is actually admitted (not merely settled).

---

### `packages/core/src/session/execution.ts` — patch **0002**

**Hunk 1** — import the status event schema.

```
BEFORE
import { Instance } from "../instance/service.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

AFTER
import { Instance } from "../instance/service.js"
import { SessionStatusEvent } from "@opencode/schema/session-status-event"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
```

**Hunk 2** — withhold the terminal while waiting; cancel pending jobs on interrupt.

```
BEFORE
            if (outcome.type === "succeeded") {
              yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, releaseOnCommit(sessionID))
              return
            }
            if (outcome.type === "interrupted") {
              // Deliberate stops release the claim; shutdown keeps it for restart continuity.
              if (outcome.reason !== "shutdown") yield* jobs.cancel(sessionID)

AFTER
            if (outcome.type === "succeeded") {
              if (yield* jobs.awaiting(sessionID)) {
                // The turn is not complete: background work will resume it. Withhold the
                // terminal so clients keep the Session active (no tick) until that work
                // finishes. Recovery of a waiting turn is owned by its durable background
                // Job record, not the orphaned-claim sweep, so release the claim now
                // instead of leaving it to look like a turn that died mid-flight.
                yield* bus.publish(SessionStatusEvent.Status, { sessionID, status: { type: "waiting" } })
                yield* store.release(sessionID)
                return
              }
              yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, releaseOnCommit(sessionID))
              return
            }
            if (outcome.type === "interrupted") {
              // Deliberate stops release the claim; shutdown keeps it for restart continuity.
              if (outcome.reason !== "shutdown") {
                yield* jobs.cancel(sessionID)
                const pending = yield* jobs.pendingFor(sessionID)
                yield* Effect.forEach(pending, (job) => jobs.cancel(job.id), { discard: true })
              }
```

**Rationale:** the core of the tick fix — a settled turn with outstanding background work publishes `waiting` and releases its claim, deferring the success terminal; abort now also cancels pending background jobs.

---

### `packages/core/src/session/execution/restart.ts` — patch **0002**

```
BEFORE
          run: execution.resume(recovery.childSessionID).pipe(
            Effect.andThen(store.context(recovery.childSessionID)),
            Effect.map((messages) => {
              const assistant = messages.findLast(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
              return SubagentCompletion.text(assistant)
            }),
          ),

AFTER
          // Resume through the layer-provided execution, not the global Session
          // service, so recovery drains via the same execution instance that
          // owns this sweep.
          run: SubagentCompletion.finalText({
            sessions: {
              resume: (sessionID) => execution.resume(sessionID),
              messages: sessions.messages,
            },
            jobs,
            sessionID: recovery.childSessionID,
          }),
```

**Rationale:** restart recovery must resume through the layer-provided `execution` and wait for the child's pending background work via `finalText`, instead of grabbing the global `Session` service.

---

### `packages/core/src/session/subagent-completion.ts` — patch **0002**

**Hunk 1** — import the session schema.

```
BEFORE
import type { SessionMessage } from "./message.js"

AFTER
import type { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
```

**Hunk 2** — add `finalText`, which runs the child to quiescence.

```
AFTER (added before `export const deliver`)
/**
 * Runs the child session to quiescence and returns its final completed response.
 * A child can end a turn while its own shell or nested subagent is still running;
 * that work admits a wake-up notification and resumes the child, so the response
 * is only final once no pending notification will wake it again.
 */
export const finalText = Effect.fnUntraced(function* (input: {
  sessions: Pick<Session.Interface, "resume" | "messages">
  jobs: Pick<Job.Interface, "pendingFor" | "awaitBackground">
  sessionID: SessionSchema.ID
}) {
  while (true) {
    yield* input.sessions.resume(input.sessionID)
    const pending = yield* input.jobs.pendingFor(input.sessionID)
    if (pending.length === 0) break
    yield* Effect.forEach(pending, (job) => input.jobs.awaitBackground(job.notificationID), {
      concurrency: "unbounded",
      discard: true,
    })
  }
  const messages = yield* input.sessions.messages({ sessionID: input.sessionID, order: "desc", limit: 20 })
  const assistant = messages.find(
    (message) => message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
  )
  return text(assistant)
})
```

**Rationale:** a subagent's response is only "final" once no pending background notification can wake the child again.

---

### `packages/core/src/session/subagent-job.ts` — patch **0002**

```
BEFORE
        run: Effect.gen(function* () {
          yield* sessions.resume(recovery.childSessionID)
          const messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
          const assistant = messages.find(
            (message) =>
              message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
          )
          return SubagentCompletion.text(assistant)
        }),

AFTER
        run: SubagentCompletion.finalText({ sessions, jobs, sessionID: recovery.childSessionID }),
```

**Rationale:** the subagent job now uses the shared `finalText` helper so it waits for child background work before reporting completion.

---

### `packages/client/src/promise/generated/types.ts` — patch **0002**

```
BEFORE
  | { type: "busy" }

export type PtyTicketConnectToken = { ticket: string; expires_in: number }

AFTER
  | { type: "busy" }
  | { type: "waiting" }

export type PtyTicketConnectToken = { ticket: string; expires_in: number }
```

**Rationale:** keeps the generated client `SessionStatus` union in sync with the schema.

---

### `packages/client/src/solid/data.ts` — patch **0002**

**Hunk 1** — widen the data status type.

```
BEFORE
export type DataSessionStatus = "idle" | "running"

AFTER
export type DataSessionStatus = "idle" | "running" | "waiting"
```

**Hunk 2** — handle the `session.status` event.

```
BEFORE
        return
      case "session.execution.started":
        setSessionActive(event.data.sessionID, "running")
        return

AFTER
        return
      case "session.status":
        if (event.data.status.type === "waiting") setSessionActive(event.data.sessionID, "waiting")
        return
      case "session.execution.started":
        setSessionActive(event.data.sessionID, "running")
        return
```

**Rationale:** the client store must reduce the new `session.status` event into the `waiting` state or it would appear idle.

---

### `packages/app/src/session/model.ts` — patch **0002**

```
BEFORE
  const status = createMemo(() => {
    const id = sessionID()

    return id && data.session.status(id) === "running" ? { type: "busy" as const } : idle
  })

AFTER
  const status = createMemo(() => {
    const id = sessionID()
    const value = id ? data.session.status(id) : undefined
    if (value === "running") return { type: "busy" as const }
    if (value === "waiting") return { type: "waiting" as const }
    return idle
  })
```

**Rationale:** the app session model surfaces `waiting` as its own status instead of collapsing it to idle.

---

### `packages/app/src/session/requests/background.ts` — patch **0002**

```
BEFORE
  status: (id: string) => "idle" | "running"

AFTER
  status: (id: string) => "idle" | "running" | "waiting"
```

**Rationale:** the background-request helper's status accessor accepts the new status.

---

### `packages/app/src/shell/routes/session-ui-provider.tsx` — patch **0002**

```
BEFORE
        .map((session) => [
          session.id,
          data.session.status(session.id) === "running" ? ({ type: "busy" } as const) : ({ type: "idle" } as const),
        ]),

AFTER
        .map((session) => {
          const status = data.session.status(session.id)
          if (status === "running") return [session.id, { type: "busy" } as const]
          if (status === "waiting") return [session.id, { type: "waiting" } as const]
          return [session.id, { type: "idle" } as const]
        }),
```

**Rationale:** propagates `waiting` into the shell's `session_status` map so UI consumers see it.

---

### `packages/app/src/composer/submit.test.ts` — patch **0002**

**Hunk 1** — widen the test helper's status type.

```
BEFORE
  statuses?: ("idle" | "running")[]

AFTER
  statuses?: ("idle" | "running" | "waiting")[]
```

**Hunk 2** — widen the local statuses array.

```
BEFORE
    const statuses: ("idle" | "running")[] = []

AFTER
    const statuses: ("idle" | "running" | "waiting")[] = []
```

**Rationale:** keeps the composer submission tests type-correct against the widened status union.

---

### `packages/tui/src/component/prompt/index.tsx` — patch **0002**

```
BEFORE (context)
                  </Match>
                  <Match when={move.progress()}>

AFTER
                  </Match>
                  <Match when={status() === "waiting"}>
                    <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
                      <box marginLeft={1}>
                        <text fg={theme.text.muted} wrapMode="none" truncate>
                          waiting for background work…
                        </text>
                      </box>
                    </box>
                  </Match>
                  <Match when={move.progress()}>
```

**Rationale:** renders an explicit "waiting for background work…" indicator while the session is waiting.

---

### `packages/tui/src/context/session-tabs.tsx` — patch **0002**

```
BEFORE
            data.session.status(id) === "running" ||

AFTER
            data.session.status(id) !== "idle" ||
```

**Rationale:** a tab with a `waiting` session counts as busy, so no premature done indicator.

---

### `packages/tui/src/routes/session/index.tsx` — patch **0002**

```
BEFORE
  const isRunning = createMemo(() => {
    const id = sessionID()
    return props.part.state.status === "running" || Boolean(id && data.session.status(id) === "running")
  })

AFTER
  const isRunning = createMemo(() => {
    const id = sessionID()
    if (props.part.state.status === "running") return true
    if (!id) return false
    const status = data.session.status(id)
    return status === "running" || status === "waiting"
  })
```

**Rationale:** the subagent tool view keeps showing "running" while the child session is waiting.

---

### `packages/plugin/src/tui/context.ts` — patch **0002**

```
BEFORE
    status(sessionID: string): "idle" | "running"

AFTER
    status(sessionID: string): "idle" | "running" | "waiting"
```

**Rationale:** exposes the widened status to TUI plugins.

---

### `packages/core/test/job.test.ts` — patch **0002**

```
AFTER (added test)
  it.live("waits for background acknowledgment before releasing an observer", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const job = yield* jobs.start({
        id: "shell_background_await",
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID: SessionSchema.ID.make("ses_background_await"),
          shellID: "shell_background_await",
          command: "echo done",
        },
        run: Effect.succeed("done"),
      })
      const background = yield* jobs.background(job.id)
      if (!background?.notificationID) return yield* Effect.die("background marker missing")

      // Settlement alone must not release an observer; only acknowledgment does.
      const waiting = yield* jobs
        .awaitBackground(background.notificationID)
        .pipe(Effect.forkIn(yield* Scope.Scope, { startImmediately: true }))
      expect(yield* Fiber.await(waiting).pipe(Effect.timeoutOption("20 millis"))).toMatchObject({ _tag: "None" })

      yield* jobs.completeBackground(background.notificationID)
      yield* Fiber.join(waiting)
      expect(yield* jobs.pendingBackground).toEqual([])
    }),
  )
```

**Rationale:** proves `awaitBackground` only releases on acknowledgment, not on job settlement.

---

### `packages/core/test/session-execution.test.ts` — patch **0002**

**Hunk 1** — import the status event.

```
BEFORE
import { SessionEvent } from "@opencode/core/session/event"

AFTER
import { SessionEvent } from "@opencode/core/session/event"
import { SessionStatusEvent } from "@opencode/schema/session-status-event"
```

**Hunk 2** — add the end-to-end waiting test (abridged below; full text in the patch).

```
AFTER (added test)
  it.effect("reports waiting without a terminal while a settled Session has outstanding background work", () =>
    Effect.gen(function* () {
      ...
      expect(observed).toEqual([SessionStatusEvent.Status.type])
      // The claim is released while waiting so the Session is not swept as an
      // orphaned in-flight turn; its recovery is owned by the durable Job record.
      expect((yield* claims(database))[sessionID]).toBe(false)

      // Once the background notification is acknowledged, the Session is no longer waiting.
      yield* jobs.completeBackground(marker.notificationID)
      expect(yield* jobs.awaiting(sessionID)).toBe(false)

      // Resuming with no outstanding work publishes the terminal, so the tick appears.
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(succeeded)
      yield* execution.awaitIdle(sessionID)
      expect(observed).toEqual([SessionStatusEvent.Status.type, SessionEvent.Execution.Succeeded.type])
    }),
  )
```

**Rationale:** verifies the session emits only `waiting` (no terminal) while background work is outstanding, then emits the terminal once acknowledged.

---

### `packages/core/test/tool-subagent.test.ts` — patch **0002**

```
AFTER (added test, abridged)
  it.live("waits for pending child background work before notifying the parent", () =>
    ...
          yield* Fiber.join(childTurn)
          yield* Effect.sleep("20 millis")
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toEqual([])

          // Acknowledging the shell notification clears its marker; only then may the child settle.
          yield* jobs.completeBackground(marker.notificationID)
          const admission = Array.from(yield* Fiber.join(notified))[0]
          ...
          expect(admission.data.item.payload.text).toContain(`<subagent sessionID="${child.id}" state="completed"`)
          expect((yield* jobs.get(child.id))?.status).toBe("completed")
  )
```

**Rationale:** verifies a subagent does not notify its parent until the child's own pending background work is acknowledged and completed.

---

## (c) Child inline steer composer

### `packages/tui/src/routes/session/index.tsx` — patch **0003**

The host hides its own `<Prompt>` for child sessions and force-opens the tabbed `Composer` subagent picker instead, so there is no free-text composer while viewing a subagent. Because `Prompt.submit()` already defaults `delivery` to `"steer"` and targets `props.sessionID`, the fix is to stop suppressing the Prompt for child sessions and stop force-opening the picker.

**Hunk 1** — make the subagent-picker toggle opt-in on child sessions (it previously always closed on a child, which would strand navigation once the picker is no longer forced open).

```
BEFORE
      run: () => {
        if (composer.open || session()?.parentID) setComposer("open", false)
        else setComposer({ open: true, tab: "subagents" })
        dialog.clear()
      },

AFTER
      run: () => {
        // Child sessions already render the inline steer composer, so the
        // picker is opt-in there: toggle it open/closed like a main session
        // instead of always closing it.
        if (composer.open) setComposer("open", false)
        else setComposer({ open: true, tab: "subagents" })
        dialog.clear()
      },
```

**Hunk 2** — only force-open the picker when the user asked for it.

```
BEFORE
              <Composer
                sessionID={route.sessionID}
                open={composer.open || (!!session()?.parentID && forms().length === 0)}

AFTER
              <Composer
                sessionID={route.sessionID}
                open={composer.open}
```

**Hunk 3** — render the host Prompt for child sessions (instead of the `null` placeholder).

```
BEFORE
                <Match when={composer.open || (!!session()?.parentID && forms().length === 0)}>{null}</Match>

AFTER
                <Match when={composer.open}>{null}</Match>
```

**Hunk 4** — label the child composer so the steer affordance is discoverable (main sessions pass no `placeholders`, so they are unchanged).

```
BEFORE
                    muted={props.promptMuted}
                    onSubmit={() => {

AFTER
                    muted={props.promptMuted}
                    // Child sessions render this same Prompt as the inline steer
                    // composer; label it accordingly. Parent/main behavior is
                    // untouched (placeholders undefined => default copy).
                    placeholders={session()?.parentID ? { normal: ["Steer this subagent…"] } : undefined}
                    onSubmit={() => {
```

**Hunk 5** — `packages/tui/src/context/local.tsx`: resolve the viewed child's own agent, and make it the only selectable/current agent. `createAgent()` gains a memo:

```
AFTER (added after `visibleAgents`)
      // A child/subagent session runs its own agent, which is frequently a
      // `mode: "subagent"` agent deliberately absent from the primary `agents()`
      // list. The composer must reflect that agent: otherwise the footer shows
      // the main agent's type, and `prepareAgent` would switch the child's agent
      // to the primary selection when a steer is submitted.
      const viewedChildAgent = createMemo(() => {
        if (route.data.type !== "session") return
        const session = data.session.get(route.data.sessionID)
        if (!session?.parentID || !session.agent) return
        return (data.location.agent.list(location.ref) ?? []).find((item) => item.id === session.agent)
      })
```

```
BEFORE
        list() {
          return agents()
        },
        current() {
          const draft = ...
AFTER
        list() {
          // While viewing a child/subagent, that session's own agent is the only
          // selectable one: its agent is fixed by the subagent it represents.
          const child = viewedChildAgent()
          return child ? [child] : agents()
        },
        current() {
          const child = viewedChildAgent()
          if (child) return child
          const draft = ...
```

`set()`/`move()` now validate/iterate `this.list()` instead of the primary-only `agents()` (identical for main sessions):

```
BEFORE
        set(id: string) {
          if (!agents().some((agent) => agent.id === id))
AFTER
        set(id: string) {
          if (!this.list().some((agent) => agent.id === id))
```

```
BEFORE
            let next = agents().findIndex((agent) => agent.id === current.id) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
AFTER
            const list = this.list()
            let next = list.findIndex((agent) => agent.id === current.id) + direction
            if (next < 0) next = list.length - 1
            if (next >= list.length) next = 0
            const value = list[next]
```

**Hunk 6** — `packages/tui/src/app.tsx`: do not carry a subagent agent into a new session (`session.new` / `session.clear`, both call sites).

```
BEFORE
          if (agent) local.agent.set(agent.id)
AFTER
          if (agent && agent.mode !== "subagent") local.agent.set(agent.id)
```

**Hunk 7** — `packages/tui/src/component/prompt/index.tsx`: render the whole composer box in a distinct blue palette while viewing a subagent. A fixed blue overlay is blended over the theme's own composer tokens.

```
AFTER (module scope, near the top)
const SUBAGENT_COMPOSER_BLUE = RGBA.fromHex("#3b82f6")
const SUBAGENT_COMPOSER_BG_ALPHA = 0.4
const SUBAGENT_COMPOSER_BORDER_ALPHA = 0.9
const SUBAGENT_COMPOSER_PLACEHOLDER_ALPHA = 0.6
```

```
BEFORE
  const promptBg = createMemo(() => theme.decrease(theme.background.raised.base))
AFTER
  const subagentComposer = createMemo(() => !!props.sessionID && !!data.session.get(props.sessionID)?.parentID)
  const promptBg = createMemo(() => {
    const base = theme.decrease(theme.background.raised.base)
    return subagentComposer() ? tint(base, SUBAGENT_COMPOSER_BLUE, SUBAGENT_COMPOSER_BG_ALPHA) : base
  })
  const promptBorder = createMemo(() =>
    subagentComposer()
      ? tint(theme.border.base, SUBAGENT_COMPOSER_BLUE, SUBAGENT_COMPOSER_BORDER_ALPHA)
      : borderHighlight(),
  )
  const promptPlaceholder = createMemo(() =>
    subagentComposer()
      ? tint(theme.text.muted, SUBAGENT_COMPOSER_BLUE, SUBAGENT_COMPOSER_PLACEHOLDER_ALPHA)
      : theme.text.muted,
  )
```

Both composer borders (`borderColor={borderHighlight()}` → `borderColor={promptBorder()}`) and the input placeholder (`theme.text.muted` → `promptPlaceholder()`) switch to the blue-aware values; the box background already reads `promptBg()`.

**Palette rationale:** `#3b82f6` is a neutral, vivid blue. Blending it over the theme's own tokens keeps the palette legible in both modes: the background retains the theme's lightness (so `theme.text.base` stays high-contrast), the border is almost pure blue, and the placeholder is a softer blue. The theme's TypeScript type exposes only semantic hues (`accent`/`interactive`/`neutral`), so a fixed blue overlay is used instead of a named `hue.blue` token (which exists at runtime but is untyped).

**Agent-type root cause:** `local.agent.current()` searched only `agents()`, which filters out `mode: "subagent"`. A child's own agent (e.g. `general`) therefore never resolved and `current()` fell back to the first primary agent. That drove both the footer label (`promptDisplay.agentLabel`) and `prepareAgent`'s `switchAgent` call (`component/prompt/index.tsx`), so submitting a steer could silently **switch the child's agent to the main agent**.

**Regression test** — `packages/tui/test/child-composer-steer.test.tsx` mounts the real app on a child and on a parent session and asserts:
- the child frame shows the `Steer this subagent` placeholder **and the child's own agent type (`General`)**, not the main agent (`Build`), the captured spans contain a **blue-dominant composer background**, and typing + Enter POSTs `{ text, delivery: "steer" }` to `/api/session/<child>/prompt` **without** any `/api/session/<child>/agent` switch;
- the parent frame shows its own agent (`Build`, never `General`), has **no** blue-dominant composer background, does **not** show the child placeholder, and typing + Enter POSTs to the parent.

**Rationale:** no `Prompt` component change is needed — it already sends to `props.sessionID` with `delivery` defaulting to `"steer"` (`packages/tui/src/component/prompt/index.tsx`); the child route simply never rendered it. Fixing `local.agent.current()` makes the composer reflect the child's own agent for the label/model **and** makes `prepareAgent` a no-op for the child. The picker remains reachable (default `down`), so normal child navigation is preserved.

**Known tradeoff (documented, not fixed):** while the child composer is focused, `session.parent` (`up`) and `session.child.first` (`down`) remain bound in the lowest keymap layer, so arrow up/down still navigate rather than move the editing cursor. This intentionally preserves navigation; a fallthrough-while-editor-has-text guard (as used by the `strayge/opencode` fork) is a possible follow-up, not included here (YAGNI).

---

## (d) Waiting-session abort

### `packages/core/src/session/execution.ts` — patch **0004**

**Hunk 1** — the `interrupt` interface doc-comment: idle is now a no-op *only* when there is no outstanding background work.

```
BEFORE
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters. `awaitSettlement` waits only for the interrupted execution,

AFTER
   * Interrupt active work owned by this process. A no-op only when idle with no outstanding
   * background work; a `waiting` Session's background work is cancelled and its terminal
   * published. Resolves once the interruption is accepted; cleanup settles asynchronously in
   * the execution fiber. Returns whether anything was interrupted. Compose with `awaitIdle`
   * when settlement matters. `awaitSettlement` waits only for the interrupted execution,
```

**Hunk 2** — when the coordinator did not interrupt a live execution, cancel the session's outstanding durable background work, clear its markers, and publish the interrupted terminal. The returned boolean is renamed `interrupted` → `settled` and now means "anything was interrupted".

```
AFTER (added)
          // A Session can settle its turn while still owning durable background work, which parks
          // it in `waiting` with no active execution for the coordinator to interrupt. Cancel that
          // work, clear its recovery marker, and publish the interrupted terminal so clients leave
          // `waiting` and the Session does not immediately re-enter it.
          let settled = interrupted
          if (!settled) {
            const pending = yield* jobs.pendingFor(sessionID)
            if (pending.length > 0) {
              yield* jobs.cancel(sessionID)
              yield* Effect.forEach(pending, (job) => jobs.cancel(job.id), { discard: true })
              yield* Effect.forEach(pending, (job) => jobs.completeBackground(job.notificationID), {
                discard: true,
              })
              yield* bus.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, reason: options?.reason ?? "user" },
                releaseOnCommit(sessionID),
              )
              settled = true
            }
          }
          if (!options?.resume) return settled
```

The three later `return interrupted` sites become `return settled` (the `resume`-path early return and the two final returns).

**Rationale:** a `waiting` session has no live execution, so `coordinator.interrupt` returns `false`; the only way to stop it is to cancel its durable background Jobs (`jobs.pendingFor` → `jobs.cancel(job.id)`) and clear their recovery markers (`jobs.completeBackground(job.notificationID)`, which also wakes `awaitBackground` waiters), then publish `session.execution.interrupted` so clients leave `waiting`. A session idle with no pending background work still takes the `false` no-op path.

---

### `packages/core/test/session-execution.test.ts` — patch **0004**

```
AFTER (added test)
  it.effect("cancels outstanding background work and settles when interrupting a waiting Session", () =>
    Effect.gen(function* () {
      ... // start a background shell job gated on a Deferred
      // The turn settled with outstanding durable work: waiting, but no active execution.
      expect(observed).toEqual([SessionStatusEvent.Status.type])
      expect(yield* execution.isActive(sessionID)).toBe(false)
      expect(yield* jobs.awaiting(sessionID)).toBe(true)

      // Interrupting a waiting Session is not a no-op: it cancels the background work,
      // clears the durable marker, and publishes the interrupted terminal.
      expect(yield* execution.interrupt(sessionID)).toBeTrue()
      yield* Deferred.await(cancelled)
      yield* Deferred.await(interrupted)
      yield* execution.awaitIdle(sessionID)

      expect(yield* jobs.awaiting(sessionID)).toBe(false)
      expect(observed).toEqual([SessionStatusEvent.Status.type, SessionEvent.Execution.Interrupted.type])
    }),
  )
```

**Rationale:** proves the waiting case is not a no-op — the job's `onInterrupt` fires, the durable marker clears (`jobs.awaiting` → `false`), and the terminal moves from `waiting` to `session.execution.interrupted`. Full test text is in the patch. (`0005` later makes this cancellation **opt-in** via `cancelBackground: true`, and the test now passes that flag — see (e).)

---

## (e) Foreground-only interrupt

### `packages/protocol/src/groups/session.ts` — patch **0005**

**Hunk 1** — accept the new `cancelBackground` query flag on the endpoint.

```
BEFORE
        query: { resume: BooleanFromString.pipe(Schema.optional) },

AFTER
        query: {
          resume: BooleanFromString.pipe(Schema.optional),
          cancelBackground: BooleanFromString.pipe(Schema.optional),
        },
```

**Hunk 2** — document the default/opt-in semantics.

```
BEFORE
              "Interrupt active execution owned by this OpenCode process. Returns interrupted=true when an active execution was interrupted and false for the idle no-op. When resume=true, ..."

AFTER
              "Interrupt active execution owned by this OpenCode process. Returns interrupted=true when an active execution was interrupted and false for the idle no-op. By default the interrupt is foreground-only: it stops a live foreground turn but leaves the Session's durable background jobs running, and interrupting a waiting Session (no active execution) is a no-op. Pass cancelBackground=true to also cancel the Session's outstanding background jobs and to settle a waiting Session. When resume=true, ..."
```

**Rationale:** the wire protocol exposes the opt-in, defaulting to the foreground-only behavior when the flag is absent.

---

### `packages/server/src/handlers/session.ts` — patch **0005**

```
BEFORE
          return { interrupted: yield* session.interrupt(ctx.params.sessionID, { resume: ctx.query.resume }) }

AFTER
          return {
            interrupted: yield* session.interrupt(ctx.params.sessionID, {
              resume: ctx.query.resume,
              cancelBackground: ctx.query.cancelBackground,
            }),
          }
```

**Rationale:** forwards the new query parameter straight to `Session.interrupt`.

---

### `packages/core/src/session.ts` — patch **0005**

**Hunk 1** — widen the `Session` interface's interrupt options.

```
BEFORE
  readonly interrupt: (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean }) => Effect.Effect<boolean>

AFTER
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: { readonly resume?: boolean; readonly cancelBackground?: boolean },
  ) => Effect.Effect<boolean>
```

**Hunk 2** — `Session.remove` keeps its pre-`0005` teardown by opting in.

```
BEFORE
        yield* execution.interrupt(sessionID)

AFTER
        // Removing a Session tears down its durable background work with it: an
        // interrupt must not leave orphaned background jobs behind.
        yield* execution.interrupt(sessionID, { cancelBackground: true })
```

**Rationale:** the interface gains the flag, and removal explicitly requests background cancellation so it never leaves orphaned durable jobs.

---

### `packages/core/src/session/execution.ts` — patch **0005**

**Hunk 1** — the `interrupt` interface doc-comment now describes the foreground-only default.

```
BEFORE
   * Interrupt active work owned by this process. A no-op only when idle with no outstanding
   * background work; a `waiting` Session's background work is cancelled and its terminal
   * published. ...

AFTER
   * Interrupt active work owned by this process. A live foreground turn is interrupted whenever
   * this process owns one. The interrupt is foreground-only by default: a `waiting` Session (no
   * active execution) is a no-op and the Session's outstanding durable background work is left
   * running. Pass `cancelBackground: true` to also cancel the Session's outstanding background
   * jobs (`jobs.cancel`, pending job cancellation, `jobs.completeBackground`) and to settle a
   * `waiting` Session with the interrupted terminal. ...
```

**Hunk 2** — record the opt-in in a per-session set so the settled hook can observe it.

```
AFTER (added in the layer body)
    // Interrupts are foreground-only by default. Only an explicit `cancelBackground` interrupt
    // cancels a Session's durable background work, so the opt-in is recorded here when
    // `Service.interrupt` runs and is consumed by whichever settlement path handles it: the
    // coordinator's settled hook for a live turn, or the waiting branch for a parked Session.
    const cancelBackgroundOnInterrupt = new Set<SessionSchema.ID>()
```

**Hunk 3** — the coordinator's `settled` hook consumes the opt-in and only cancels background jobs when it was requested.

```
BEFORE
            const outcome = terminal(exit, reason)
            ...
              if (outcome.reason !== "shutdown") {
                yield* jobs.cancel(sessionID)
                const pending = yield* jobs.pendingFor(sessionID)
                yield* Effect.forEach(pending, (job) => jobs.cancel(job.id), { discard: true })

AFTER
            // Consume the opt-in recorded by `Service.interrupt`. ...
            const cancelBackground = cancelBackgroundOnInterrupt.delete(sessionID)
            const outcome = terminal(exit, reason)
            ...
              if (outcome.reason !== "shutdown" && cancelBackground) {
                yield* jobs.cancel(sessionID)
                const pending = yield* jobs.pendingFor(sessionID)
                yield* Effect.forEach(pending, (job) => jobs.cancel(job.id), { discard: true })
```

**Hunk 4** — `Service.interrupt` records the opt-in before interrupting, and the `waiting` branch only cancels/terminalizes when `cancelBackground` was requested.

```
AFTER
        interrupt: (sessionID, options) =>
          Effect.gen(function* () {
            const cancelBackground = options?.cancelBackground === true
            // Record the opt-in before interrupting so the settled hook of the live turn we are
            // about to stop observes it; the hook consumes the flag when it runs.
            if (cancelBackground) cancelBackgroundOnInterrupt.add(sessionID)
            const interrupted = yield* coordinator.interrupt(sessionID, options?.reason ?? "user", options)
            ...
            let settled = interrupted
            if (!settled) {
              if (cancelBackground) {
                const pending = yield* jobs.pendingFor(sessionID)
                if (pending.length > 0) { ... publish SessionEvent.Execution.Interrupted ... }
              }
              // No active execution was interrupted, so no settled hook will consume the opt-in.
              cancelBackgroundOnInterrupt.delete(sessionID)
            }
```

**Rationale:** the two settlement paths (a live turn's coordinator hook, and the `waiting` branch) now share one opt-in signal, so a default interrupt is foreground-only and `cancelBackground: true` reproduces the old `0002`/`0004` behavior.

---

### `packages/core/src/session/session.ts` — patch **0005**

```
BEFORE
    (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean }) =>

AFTER
    (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean; readonly cancelBackground?: boolean }) =>
```

**Rationale:** the public `Session.interrupt` facade accepts and forwards the flag.

---

### `packages/core/src/location-activity.ts` — patch **0005**

```
BEFORE
                (session) => execution.interrupt(session.id, { reason: "inactivity", awaitSettlement: true }),

AFTER
                (session) =>
                  execution.interrupt(session.id, {
                    reason: "inactivity",
                    awaitSettlement: true,
                    cancelBackground: true,
                  }),
```

**Rationale:** the inactivity reaper must keep tearing down a reaped Session's durable background work; a foreground-only interrupt would regress that.

---

### Generated client files — patch **0005**

Four generated files keep the typed client in sync with the new query parameter:

- `packages/client/src/effect/api/api.ts` — `SessionInterruptInput` gains `cancelBackground?: boolean`.
- `packages/client/src/effect/generated/client.ts` — the interrupt endpoint forwards `cancelBackground` in the query.
- `packages/client/src/promise/generated/client.ts` — the promise client sends `query: { resume, cancelBackground }`.
- `packages/client/src/promise/generated/types.ts` — `SessionInterruptInput` gains `cancelBackground?`.

**Rationale:** the generated clients mirror the protocol so callers can request background cancellation.

---

### Core tests — patch **0005**

- `packages/core/test/session-execution.test.ts` — updates the two prior interrupt tests to pass `{ cancelBackground: true }`, and adds two tests: a default interrupt of a **running** turn stops the foreground turn but leaves the durable background job `running`, and a default interrupt of a **waiting** Session is a `false` no-op that publishes no terminal and leaves the background job `running`.
- `packages/core/test/location-activity.test.ts` — adds a test proving inactivity eviction still cancels the evicted Session's durable background work (`cancelBackground: true`).
- `packages/core/test/session-remove.test.ts` — records the interrupt options forwards and asserts `Session.remove` calls `execution.interrupt(id, { cancelBackground: true })`.

**Rationale:** pins the foreground-only default and the explicit-teardown opt-ins.

---

## (f) Cancelled jobs do not revive their owner

### `packages/core/src/session/subagent-completion.ts` — patch **0006**

**Hunk 1** — a cancelled child's notice is admitted with `resume: false`.

```
BEFORE
    ...(input.resume === false ? { resume: false } : {}),

AFTER
    // A cancelled child is admitted for context, but only a real completion or failure
    // should revive the parent; cancellation is the parent's own abort taking effect.
    ...(input.resume === false || input.status === "cancelled" ? { resume: false } : {}),
```

**Rationale:** when a subagent is aborted, its terminal notice is still admitted into the parent's inbox for context, but it must not resume the parent — the cancellation is the parent's own abort taking effect, so reviving it into a new turn is wrong.

---

### `packages/core/src/tool/plugin/shell.ts` — patch **0006**

**Hunk 1** — a cancelled background job's notice is admitted with `resume: false`.

```
BEFORE
          ...(info.notificationID ? { id: info.notificationID } : {}),
          sessionID,
          description: command,

AFTER
          ...(info.notificationID ? { id: info.notificationID } : {}),
          sessionID,
          description: command,
          // A cancelled job's notice is still admitted, but it must not revive an idle
          // owner: only a real completion (or failure) is worth a new model turn.
          ...(info.status === "cancelled" ? { resume: false } : {}),
```

**Rationale:** `notifyWhenDone` delivered a cancelled job's notice with the default `resume: true`, so cancelling a background shell job woke the idle owner into a new turn. Cancellation now admits the notice without reviving the owner.

---

### Tests — patch **0006**

- `packages/core/test/session-execution.test.ts` — imports `SubagentCompletion`, retitles and re-asserts the user-cancelled background child test (`drained` is now `[]`: the cancelled notice is admitted for context but does not revive the parent), and adds a test that `SubagentCompletion.deliver` with `status: "cancelled"` wakes no one while a `status: "completed"` deliver still wakes the parent.
- `packages/core/test/tool-shell.test.ts` — the harness execution layer's `wake` now records resumed owners (`wakes`), and two tests pin the behavior: a cancelled background shell is admitted (`state: "cancelled"`) with **no** wake, while a completed background shell still wakes the owner.

**Rationale:** pins both halves — a cancellation is admitted but non-reviving, while a real completion still resumes the owner.

---

## How to apply

Apply against a **clean upstream v2.0.23 checkout** (`0fd7e2829449b052abf0078666669302923d77af`), in order:

```bash
git clone https://github.com/sst/opencode opencode-verify
cd opencode-verify
git checkout 0fd7e2829449b052abf0078666669302923d77af   # tag v2.0.23

git apply /path/to/patches/0001-remove-parentid-sidebar-gate.patch
git apply /path/to/patches/0002-session-waiting-status-tick-fix.patch
git apply /path/to/patches/0003-child-composer-steer.patch
git apply /path/to/patches/0004-abort-waiting-session.patch
git apply /path/to/patches/0005-interrupt-foreground-only.patch
git apply /path/to/patches/0006-abort-does-not-resume.patch
```

`0001` and `0002` apply cleanly (all 20 files, no fuzz, no rejects) and reproduce the `c212f31561` tree; `0003` then applies cleanly on top (the route/context/app/prompt changes plus its regression test), `0004` applies cleanly on top of that, and `0005` applies cleanly on top of `0001`–`0004`. `0004` touches only `packages/core` (`execution.ts` plus its test), so — like `0003` — it is additive and does not modify any `0001`/`0002` file or the `0003` TUI files. `0005` touches `packages/protocol`, `packages/server`, `packages/core` (`session.ts`, `session/execution.ts`, `session/session.ts`, `location-activity.ts`), the four generated client files, and three core tests — it contains no `packages/tui` hunks, so it too leaves the `0003` TUI changes untouched. `0006` applies cleanly on top of `0001`–`0005` and touches only `packages/core` (`session/subagent-completion.ts`, `tool/plugin/shell.ts`, and the two tests `session-execution.test.ts` + `tool-shell.test.ts`), so it too is additive.

**Reproduction proof.** After applying `0001`+`0002` and staging the result, the resulting Git tree is identical to the rebased head's tree:

```
git add -A
git write-tree
# => 934165bfed50ce088418d0c4ac1c15a44e9e8762

git -C <rebased-clone> rev-parse 'c212f315615f2f6eeff6c706f54dd61153d6f5ba^{tree}'
# => 934165bfed50ce088418d0c4ac1c15a44e9e8762
```

The tree hash `934165bfed50ce088418d0c4ac1c15a44e9e8762` is the same from both routes, so `0001`+`0002` exactly reproduce the `c212f31561` tree — nothing more, nothing less. This proof covers `0001`+`0002` **only**: `0003` and `0004` are additive patches applied on top of that tree and are deliberately not folded into this hash.
