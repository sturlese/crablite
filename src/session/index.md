# src/session — durable conversation transcripts

## Purpose

One conversation per `(channel, chatType, chatId)`, persisted so restarts resume seamlessly. A JSON
index maps a stable key to a session id and a transcript file; the transcript is append-only JSONL
of Responses API items, so "resume" is just reloading the input array.

## Key entry points

`store.ts` is the whole directory.

| Export | Role |
| --- | --- |
| `sessionKeyFor(channel, chatType, chatId)` | **The only way to build a `SessionKey`** (branded type). Format: `crablite:<channel>:<chatType>:<chatId>`. |
| `loadSession(key)` | Creates the index entry + transcript file on first use; returns `{ sessionKey, sessionId, file, items }`. |
| `appendItems(session, items)` | Appends to the JSONL, mutates `session.items` in place, touches `updatedAt`. |
| `resetSession(key)` | `/reset`: deletes the index entry and unlinks the transcript. |
| `getFlushedChars(key)` / `setFlushedChars(key, n)` | Flush throttling state, stored on the index entry. |

## Use these

- **`sessionKeyFor`** — always. The `SessionKey` brand exists because a hand-built string that
  drifts from the format silently forks a chat's history between the reactive (`handle.ts`) and
  proactive (`heartbeat.ts`) paths.
- **`appendItems`** for writing; it keeps the file and the in-memory array consistent.
- **`ResponseItem` builders** from `codex/responses.ts` to construct anything you persist.

## Avoid / anti-patterns

- Do **not** cast a string to `SessionKey`. If you need a key, you need `sessionKeyFor`.
- Do **not** mutate `session.items` directly — `appendItems` owns the file/memory pair.
- Do **not** assume `pruneForContext` returns a copy. When the transcript is under budget it
  returns `session.items` itself; appending before building the model input duplicates the turn
  (see the comment in `agent/runner.ts`).
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
- Transcript files are created with mode `0600`.
- The `type: "session"` header line is skipped on load.

## Tests

`test/store.test.ts` — creation, append/reload round-trip, `/reset` (index entry *and* file
removal), flushed-chars accounting, corrupt-line tolerance.

## Common tasks

| Task | Where |
| --- | --- |
| Add per-session metadata | `IndexEntry` in `store.ts` (+ a getter/setter pair, like `flushedChars`) |
| Change the session granularity | `sessionKeyFor` — note this invalidates existing sessions |
| Inspect a live conversation | `~/.crablite/sessions/<sessionId>.jsonl` (one JSON item per line) |

## Notes

- `resetSession` deletes the transcript file because once the index entry is gone the file is
  unreachable; repeated `/reset` would otherwise accumulate orphans forever.
- The CLI channel uses a single fixed key (`crablite:cli:direct:cli`), so terminal debugging has
  one continuous history.
