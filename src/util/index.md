# src/util — shared primitives

## Purpose

Small, dependency-free primitives shared across the app. Currently: a keyed async mutex and the
graceful-shutdown drain built on top of it. Because every chat turn runs through `withLock`, the
lock map doubles as the shutdown seam — `drainLocks` awaits it so in-flight and queued work
finishes before the process exits.

## Key entry points

`lock.ts`:

| Export | Role |
| --- | --- |
| `withLock(key, fn)` | Serialize async work by key. Returns `fn`'s result (and propagates its rejection). |
| `drainLocks(timeoutMs)` | Await all in-flight **and queued** locked work, bounded. Re-sweeps the map, so work queued *during* the drain (e.g. a deferred memory flush scheduled by a finishing turn) is picked up. Resolves `true` when everything settled, `false` on timeout. **Never rejects.** |

## INVARIANT — chat lock keys are the raw `chatId`

Three modules couple on the *same* lock key for a chat, and correctness depends on it:

- `handle.ts` — reactive turns: `withLock(chatId, …)`;
- `heartbeat.ts` — proactive turns (reminders, routines, check-in): `withLock(r.chatId, …)`;
- `agent/runner.ts` — the **deferred memory flush** is queued with `withLock(chatId, …)` so it
  lands after the current turn and serializes against every other turn for that chat.

If any of them namespaced or transformed the key, turns and flushes would stop serializing against
each other and could interleave writes to the same session. Any **new** lock user for a different
resource must use a *prefixed* key (`"<namespace>:<id>"`) precisely so it can never collide with a
chat lock.

## Use these

- **`withLock(chatId, …)`** around every agent turn (see the invariant above).
- **`drainLocks(SHUTDOWN_DRAIN_MS)`** only from the shutdown path (`registerShutdown` in
  `src/index.ts`), *after* intake is paused, schedulers are stopped and pending batches are flushed
  — otherwise new work keeps arriving and the drain chases a moving target.
- The same mutex is appropriate for any per-file or per-resource serialization (with a prefixed
  key).

## Avoid / anti-patterns

- Do **not** add a locking library. This is ~50 lines and process-local, which matches the
  single-process design.
- Do **not** let a rejection break the queue. `prev.then(fn, fn)` runs the next task after the
  previous settles **either way** — a failed turn must not deadlock a chat forever. Preserve that.
- Do **not** make `drainLocks` rejectable or unbounded. Shutdown races `docker stop`'s
  `stop_grace_period` (30s); the internal cap is 25s (`SHUTDOWN_DRAIN_MS` in `src/index.ts`) and a
  `false` result must exit anyway, not throw.
- Do **not** hold a lock across an unbounded wait. A turn is already bounded by `idleTimeoutMs`;
  anything longer should be restructured, not locked. A task that never settles leaves a
  **permanent tail** for its key — later `withLock`/`drainLocks` touching it hang until their own
  timeout (documented and exploited by the last test in `test/lock.test.ts`).
- Do **not** expect cross-process safety. If crablite ever runs more than one process against one
  state dir, this needs to become a real file lock.

## Data & contracts

- `tails: Map<key, Promise<void>>`. Self-pruning: a key is deleted once its tail is the last
  queued task, so long-running processes do not leak an entry per chat.
- Tail promises never reject (settlement is swallowed), which is what makes `Promise.all` inside
  `drainLocks` safe.
- The drain timeout timer is `unref()`ed so it can never keep the shutting-down process alive.

## Tests

`test/lock.test.ts` — `withLock`: serialization order, result/rejection propagation without
deadlock, map cleanup. `drainLocks`: immediate resolve on an empty map, waiting for in-flight
work, the re-sweep picking up work queued mid-drain, and timeout ⇒ `false` (kept last in the file
because its never-settling task poisons the shared map).

## Common tasks

| Task | Where |
| --- | --- |
| Serialize a new resource | `withLock("<namespace>:<id>", fn)` — prefix the key (see invariant) |
| Change the shutdown drain budget | `SHUTDOWN_DRAIN_MS` in `src/index.ts` (keep it under compose's `stop_grace_period`) |
| Add another shared primitive | New file here; keep it dependency-free and unit-testable |

## Notes

Keys are plain strings and share one map. Chat locks use the raw `chatId` **by contract** (see the
invariant); everything else must prefix.
