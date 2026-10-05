# PATCHES.md — `opencode-patched` vs upstream OpenCode v2.0.23

Exact, per-file record of what this patch set changes relative to upstream **v2.0.23**. Nothing here is aspirational: the hunks below are the actual patch contents, and the two patch files together reproduce the rebased source tree byte-for-byte (verified tree hash below).

---

## Behavioral summary

What these patches actually do:

1. **Waiting status while background work is outstanding.** When a session's turn settles as "succeeded" but the session still owns outstanding durable background work (shell jobs it started, or a subagent awaiting its child), the core **withholds `SessionEvent.Execution.Succeeded`** and instead publishes a `session.status` event with `{ type: "waiting" }`. Clients therefore do not reduce the session to `idle`, so the completion tick does not appear. The terminal is emitted only once the background work is acknowledged and resumes/completes the turn.
2. **TUI treats `waiting` as running (busy).** The sidebar tab "busy" computation, the subagent running indicator, and the app session model all treat `waiting` as an active, non-idle status. The TUI shows a `waiting for background work…` line instead of a done tick.
3. **Sidebar gate removed.** `packages/tui/src/component/session-frame.tsx` no longer hides the sidebar for sessions with a `parentID`, so subagent/child sessions render in the sidebar tree.
4. **Abort cancels pending background jobs.** When a turn is interrupted, the session's pending background jobs are cancelled in addition to the session job itself, so aborting a waiting session actually clears the outstanding work.
5. **Subagent background-completion fixes.** Subagent completion now runs the child to quiescence, waiting for its pending background notifications (`awaitBackground`) before finalizing the response, and restart recovery drains through the provided execution instance rather than the global `Session` service.
6. **Generated client types and schema** gain the `waiting` status member, and extensive tests cover the new behavior.

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
| **Total** | **20** | Matches the branch diff exactly |

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

## How to apply

Apply against a **clean upstream v2.0.23 checkout** (`0fd7e2829449b052abf0078666669302923d77af`), in order:

```bash
git clone https://github.com/sst/opencode opencode-verify
cd opencode-verify
git checkout 0fd7e2829449b052abf0078666669302923d77af   # tag v2.0.23

git apply /path/to/patches/0001-remove-parentid-sidebar-gate.patch
git apply /path/to/patches/0002-session-waiting-status-tick-fix.patch
```

Both patches apply cleanly (all 20 files, no fuzz, no rejects).

**Reproduction proof.** After applying both patches and staging the result, the resulting Git tree is identical to the rebased head's tree:

```
git add -A
git write-tree
# => 934165bfed50ce088418d0c4ac1c15a44e9e8762

git -C <rebased-clone> rev-parse 'c212f315615f2f6eeff6c706f54dd61153d6f5ba^{tree}'
# => 934165bfed50ce088418d0c4ac1c15a44e9e8762
```

The tree hash `934165bfed50ce088418d0c4ac1c15a44e9e8762` is the same from both routes, so the two patch files exactly reproduce the rebased tree — nothing more, nothing less.
