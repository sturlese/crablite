# test — the Vitest suite

## Purpose

Unit and integration coverage for the logic that matters: memory and dreaming, the tool sandbox,
path containment, the SSRF guard, the agent loop, Codex auth/refresh and SSE parsing, inbound
admission, scheduling, and the proactive loop. Only the network (model/transport) and hardware
(WhatsApp socket, TTY) are mocked — the filesystem runs for real against a temp state dir.

## Key entry points

| File | Role |
| --- | --- |
| `helpers.ts` | **Start here.** `tmpState()` (isolated state dir + cleared env + config **and session** cache resets), `cleanup(dir)`, `fakeJwt(payload)`. |
| `vitest.config.ts` (repo root) | Include glob `test/**/*.test.ts`, `isolate: true`, coverage provider/thresholds and exclusions. |

## Use these

- **`tmpState()` in `beforeEach` and `cleanup()` in `afterEach`.** It creates a fresh
  `CRABLITE_STATE_DIR`, deletes stray `CRABLITE_*` env vars, and calls `resetConfigCache()` **and**
  `resetSessionCache()` — without those resets, a config or a cached session from an earlier test
  leaks into this one (`SessionKey` does not include the state dir, so the session cache would
  happily serve another test's transcripts). Every test file uses it, including `handle.test.ts`.
- **`drainLocks(…)` to settle queued lock work** before asserting — the pattern in
  `handle.test.ts` (flushPending) and `runner.test.ts` (deferred flush): it awaits everything
  queued on the shared lock map without guessing timeouts.
- **`fakeJwt({...})`** to build credentials with real identity/expiry claims.
- **Real files over mocked `fs`.** The workspace layout, atomic writes and permissions are part of
  the contract; testing them for real is why `tmpState` exists.
- **`vi.stubGlobal("fetch", …)`** (the pattern in the existing transport tests) to drive `callModel`
  and `safeFetchText`.

## Avoid / anti-patterns

- Do **not** mock `fs` or `paths`. Point `CRABLITE_STATE_DIR` at a temp dir instead.
- Do **not** let a test touch the developer's real `~/.crablite`. Every test that reads state must
  go through `tmpState()`.
- Do **not** set `process.env` without clearing it. `isolate: true` protects across files, not
  within one — `tmpState()` clears the known `CRABLITE_*` keys for you.
- Do **not** make real network calls. Any un-stubbed `fetch` in CI is a bug.
- Do **not** add tests for the excluded thin adapters (`src/index.ts`, `channels/whatsapp.ts`,
  `channels/cli.ts`, `dreaming-cron.ts`, `logger.ts`) just to move coverage. Extract the pure part
  instead — `extractText`/`extractQuoted` in `whatsapp.ts` is the pattern to follow.
- Do **not** depend on the wall clock. `computeNextRun`, `dueReminders`, `dueRoutines` and
  `scoreEntry` all accept an injectable "now"/"today"; use it.

## Data & contracts

One test file per module area, named after the module:

| Area | Files |
| --- | --- |
| Agent | `runner`, `loop`, `tools`, `prune`, `system-prompt`, `subagent` |
| Scheduling | `reminders`, `routines`, `schedule-tools`, `heartbeat`, `heartbeat-routines` |
| Memory | `workspace`, `search`, `recall`, `flush`, `dreaming` |
| Codex | `auth`, `responses`, `responses-call` |
| Platform | `paths`, `config`, `logger`, `lock`, `store`, `loader`, `safe-fetch` |
| Channels/media | `handle`, `whatsapp-extract`, `files`, `stt` |

Coverage thresholds (enforced in CI): lines/statements/functions 75%, branches 65%.

## Common tasks

| Task | Where |
| --- | --- |
| Run everything | `pnpm test` |
| Watch mode | `pnpm test:watch` |
| Coverage (as CI runs it) | `pnpm test:coverage` |
| One file | `pnpm vitest run test/dreaming.test.ts` |
| Add a module's tests | New `test/<module>.test.ts` using `tmpState()` |

## Notes

- `heartbeat.ts` is deliberately **not** excluded from coverage: it carries real delivery,
  overlap-guard and fallback logic, and has two dedicated test files.
- Tests are the executable specification for the trickier invariants (flush throttling, promotion
  gates, the reminder at-least-once claim/confirm ordering). Read them before changing those
  behaviours.
- The hot-path/shutdown behaviours have dedicated describes: the session cache in
  `store.test.ts` ("session cache" — object identity + reset), `drainLocks` in `lock.test.ts`
  (empty map, in-flight work, mid-drain re-sweep, timeout ⇒ `false`), deferred flush scheduling in
  `runner.test.ts` ("runTurn memory flush scheduling"), and `flushPending` in `handle.test.ts`
  ("flushPending (graceful shutdown)").
- The reminder at-least-once protocol likewise: the store phases in `reminders.test.ts`
  ("at-least-once claims" — claim/confirm, `dueReminders` gates, idempotent sweep), delivery in
  `heartbeat.test.ts` ("heartbeat at-least-once delivery" — stale-claim retry, abandonment at
  exactly the third failed attempt with a single id-only error log, the crash-exhausted zombie
  sweep, the cancel-between-snapshot-and-claim race), and the "delivery failed" annotation in
  `schedule-tools.test.ts`.
- The timeout case in `lock.test.ts` is deliberately **last in its file**: its never-settling task
  leaves a permanent tail in the module-level lock map, poisoning any later `withLock`/`drainLocks`
  in the same file.
