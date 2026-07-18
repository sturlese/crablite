# src/session — durable conversation transcripts

## Purpose

One conversation per `(channel, chatType, chatId)`, persisted so restarts resume seamlessly. A JSON
index maps a stable key to a session id and a transcript file; the transcript is append-only JSONL
of Responses API items, so "resume" is just reloading the input array.

Sessions are **cached in-process** after the first load, so a turn does not re-read and re-parse
the whole (ever-growing) transcript on every message. This is safe because the process is the
transcript's only writer and `withLock(chatId)` serializes turns per chat.

## Key entry points

`store.ts` is the whole directory.

| Export | Role |
| --- | --- |
| `sessionKeyFor(channel, chatType, chatId)` | **The only way to build a `SessionKey`** (branded type). Format: `crablite:<channel>:<chatType>:<chatId>`. |
| `loadSession(key)` | Creates the index entry + transcript file on first use. Cached: after the first call it returns **the same mutable `Session` object** for that key. |
| `appendItems(session, items)` | Appends to the JSONL, mutates `session.items` in place, touches `updatedAt`. |
| `resetSession(key)` | `/reset`: evicts the cache entry, deletes the index entry, unlinks the transcript. |
| `resetSessionCache()` | Test-facing (mirrors `resetConfigCache`): drop every cached session. Wired into `test/helpers.ts` `tmpState()`. |
| `getFlushedChars(key)` / `setFlushedChars(key, n)` | Flush throttling state, stored on the index entry (read/written on disk, not cached). |

## Object-identity contract (load-bearing)

`loadSession(key)` returns the **same object** on every call for a key. Every caller shares one
`items` array, and `appendItems` mutating it in place is what keeps memory and disk consistent.
Consequences:

- Treat `session.items` as **shared mutable state under the chat lock**. Snapshot-copy
  (`[...items]`) before handing it to anything that runs later or outside the lock — this is
  exactly why `agent/runner.ts` copies the input for the deferred memory flush at scheduling time.
- Never clone a `Session` and append to the clone; the cache (and the next caller) will not see it.
- Never hold a reference across a `resetSession` — after eviction the old object is orphaned and
  writes to it go to a deleted file.

## Use these

- **`sessionKeyFor`** — always. The `SessionKey` brand exists because a hand-built string that
  drifts from the format silently forks a chat's history between the reactive (`handle.ts`) and
  proactive (`heartbeat.ts`) paths.
- **`appendItems`** for writing; it keeps the file and the in-memory array consistent.
- **`resetSessionCache()` in tests** — it runs inside `tmpState()`, so using the standard helper is
  enough.
- **`ResponseItem` builders** from `codex/responses.ts` to construct anything you persist.

## Avoid / anti-patterns

- Do **not** cast a string to `SessionKey`. If you need a key, you need `sessionKeyFor`.
- Do **not** mutate `session.items` directly — `appendItems` owns the file/memory pair.
- Do **not** assume `pruneForContext` returns a copy. When the transcript is under budget it
  returns `session.items` itself; appending before building the model input duplicates the turn
  (see the comment in `agent/runner.ts`).
- Do **not** introduce a second writer process. The cache's single-writer assumption is what makes
  it sound; an external writer would make cached items silently stale.
- Do **not** prune what is *stored*. Pruning trims what is *sent*; the transcript is the durable
  record.
- Do **not** rewrite the JSONL. It is append-only; corrupt lines are skipped on load, which is what
  makes a crash mid-write survivable.
- Do **not** write the index non-atomically — `writeJsonFileAtomic` (tmp + rename, `0600`).

## Data & contracts

```
~/.crablite/sessions/sessions.json      { [sessionKey]: { sessionId, file, createdAt, updatedAt, flushedChars? } }
~/.crablite/sessions/<sessionId>.jsonl  line 1: { type: "session", sessionId, sessionKey, createdAt }
                                        then:   { ts, item: ResponseItem }
```

- `SessionKey = string & { readonly __sessionKey: unique symbol }`.
- In-process: `sessionCache: Map<SessionKey, Session>` — one entry per key, evicted only by
  `resetSession` / `resetSessionCache`.
- Transcript files are created with mode `0600`.
- The `type: "session"` header line is skipped on load.

## Tests

`test/store.test.ts` — creation, append/reload round-trip, `/reset` (cache eviction + index entry
*and* file removal), flushed-chars accounting, corrupt-line tolerance, and a dedicated
`session cache` describe (object identity across `loadSession` calls, cache reset behaviour).

**Test-isolation trap:** `SessionKey` does not include the state dir. Tests swap
`CRABLITE_STATE_DIR` per test, so a stale cache would leak one test's sessions into the next —
`tmpState()` calls `resetSessionCache()` for exactly this reason. Any test touching sessions must
go through `tmpState()`.

## Common tasks

| Task | Where |
| --- | --- |
| Add per-session metadata | `IndexEntry` in `store.ts` (+ a getter/setter pair, like `flushedChars`) |
| Change the session granularity | `sessionKeyFor` — note this invalidates existing sessions |
| Inspect a live conversation | `~/.crablite/sessions/<sessionId>.jsonl` (one JSON item per line) |
| Session state looks stale in a test | Missing `tmpState()` (which resets the cache) |

## Notes

- `resetSession` deletes the transcript file because once the index entry is gone the file is
  unreachable; repeated `/reset` would otherwise accumulate orphans forever.
- The CLI channel uses a single fixed key (`crablite:cli:direct:cli`), so terminal debugging has
  one continuous history.
- `flushedChars` deliberately stays on the disk index (not the cached object): it is a throttle
  written at flush-scheduling time and read the same way, and keeping it out of `Session` avoids a
  second source of truth.
