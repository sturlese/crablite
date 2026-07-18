# src/util — shared primitives

## Purpose

Small, dependency-free primitives shared across the app. Currently one: a keyed async mutex.

## Key entry points

`lock.ts`:

| Export | Role |
| --- | --- |
| `withLock(key, fn)` | Serialize async work by key. Returns `fn`'s result (and propagates its rejection). |

## Use these

- **`withLock(chatId, …)`** around every agent turn. Both the reactive path (`handle.ts`) and the
  proactive path (`heartbeat.ts` — reminders, routines, daily check-in) route through it, which is
  what guarantees two turns never write the same session concurrently.
- The same primitive is appropriate for any per-file or per-resource serialization.

## Avoid / anti-patterns

- Do **not** add a locking library. This is 20 lines and process-local, which matches the
  single-process design.
- Do **not** let a rejection break the queue. `prev.then(fn, fn)` runs the next task after the
  previous settles **either way** — a failed turn must not deadlock a chat forever. Preserve that.
- Do **not** hold a lock across an unbounded wait. A turn is already bounded by `idleTimeoutMs`;
  anything longer should be restructured, not locked.
- Do **not** expect cross-process safety. If crablite ever runs more than one process against one
  state dir, this needs to become a real file lock.

## Data & contracts

`tails: Map<key, Promise<void>>`. The map is self-pruning: a key is deleted once its tail is the
last queued task, so long-running processes do not leak an entry per chat.

## Tests

`test/lock.test.ts` — serialization order, result propagation, rejection propagation without
deadlocking subsequent tasks, and map cleanup.

## Common tasks

| Task | Where |
| --- | --- |
| Serialize a new resource | `withLock("<namespace>:<id>", fn)` — namespace the key to avoid collisions |
| Add another shared primitive | New file here; keep it dependency-free and unit-testable |

## Notes

Keys are plain strings and share one map. Chat locks currently use the raw `chatId`; if you lock
something else, prefix it.
