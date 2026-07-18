# src — application root

## Purpose

All crablite code. One process, one agent: a channel receives a message, `handle.ts` admits and
serializes it, `agent/runner.ts` runs a turn against the Codex Responses API with tools, and the
reply goes back to the chat. Proactive turns (`heartbeat.ts`) enter the same path without a user
message.

Subdirectories each have their own `index.md`. This file covers the top-level modules and the
cross-cutting rules.

## Key entry points

| File | Role |
| --- | --- |
| `index.ts` | CLI dispatch: `login`, `chat [--once]`, `whatsapp`/`start` (default), `dream`, `doctor`, `help`. Composition root for the WhatsApp run (channel + handler + schedulers) **and owner of graceful shutdown**: `registerShutdown` on SIGINT/SIGTERM — pause intake → stop schedulers → `flushPending` → `drainLocks(25s)` → close socket → exit 0 (a second signal exits 1; each step is error-isolated via `attempt`). |
| `handle.ts` | **The shared inbound seam.** `createInboundHandler(channelId)` returns `InboundHandler = { onInbound, flushPending }`: `onInbound` is admission → dedupe → debounce → per-chat lock → delivery; `flushPending` is the shutdown hook that forces debounce-pending batches into the lock queue. Also exports `formatForModel` and `withTypingIndicator`. |
| `heartbeat.ts` | `startHeartbeat(channel): () => void` — the proactive loop; returns a stop handle used by shutdown. Reminders are delivered **at-least-once** (claim → rich turn → send(s) → confirm; plain `⏰` fallback), routines advance-first (at-most-once per occurrence), optional daily check-in. **Invariant:** the whole reminder protocol runs inside ONE `withLock(chatId)` scope — `deliverDueReminders` takes the lock, `deliverReminder` must never take it itself — so the shutdown drain can never exit between a successful send and its confirm (the gap that would guarantee a post-restart duplicate). |
| `dreaming-cron.ts` | `startDreamingScheduler(): () => void` — runs `runDreaming` once a day at `dreamHour`. Returns a stop handle used by shutdown. |
| `config.ts` | `loadConfig()` — flat config, file then env (env wins). `resetConfigCache()` for tests. |
| `paths.ts` | **Every path in the system.** State layout, dir/secret helpers, containment helpers. |
| `logger.ts` | `log.{debug,info,warn,error}` + `makeBaileysLogger()`. |
| `version.ts` | `CRABLITE_VERSION`, `USER_AGENT`, `ORIGINATOR`. |

## Use these

- **`paths.ts` for anything on disk.** `paths.workspace()`, `paths.sessionsDir()`, … Never
  `path.join(os.homedir(), ".crablite", …)` by hand — `CRABLITE_STATE_DIR` must keep working (the
  whole test suite depends on it).
- **`resolveInside(root, p)` / `resolveReadable(workspaceDir, p)`** before touching any path that
  came from the model or from a JSON store. This is the filesystem containment boundary.
- **`writeJsonFileAtomic` / `writeSecretFile`** for persisted state and secrets (atomic, `0600`).
- **`withLock(chatId, fn)`** (`util/lock.ts`) around anything that runs a turn for a chat.
- **`log` from `logger.ts`**, never `console.*`. Log-content posture: user content (reminder
  text, message bodies) never goes to `error`/`warn` — log **ids and counts** at error and the
  content at `debug` (the pattern set by `logAbandoned` in `heartbeat.ts`).
- **`loadConfig()`** — it is cached; call it freely instead of threading config through parameters.

## Avoid / anti-patterns

- Do **not** add a second inbound path. Every channel must funnel through `createInboundHandler`
  so admission, dedupe, debounce and locking apply uniformly. A channel that calls `runTurn`
  directly bypasses the allowlist.
- Do **not** run a turn for a chat outside `withLock(chatId, …)`. Reactive and proactive turns share
  one session file; concurrent writes fork the history.
- Do **not** widen `allowFrom` defaults or make admission fail-open. Empty means ignore everyone,
  on purpose.
- Do **not** read env vars ad hoc for behaviour that belongs in `Config`. Add a key to `config.ts`
  with a default, and an env override only if operators need it.
- Do **not** hardcode the version string anywhere — `version.ts` re-exports it from `package.json`,
  which is the single source. Bump it there (or via the release flow) and nowhere else.
- Do **not** import `.ts` extensions in local imports. This is ESM: import `./foo.js` from
  `foo.ts`.

## Data & contracts

- `Config` (`config.ts`) — the whole tunable surface; see the README table for defaults.
- `paths` (`paths.ts`) — the on-disk layout contract; changing a key is a migration.
- `InboundMessage` / `Channel` (`channels/types.ts`) — the channel contract.
- `InboundHandler = { onInbound, flushPending }` (`handle.ts`) — what a channel's `start` consumes
  (`handler.onInbound`) plus the shutdown hook.
- `ResponseItem` (`codex/responses.ts`) — the closed union persisted per transcript line.
- `SessionKey` (`session/store.ts`) — branded string; only `sessionKeyFor` can produce one.
- `HeartbeatChannel` (`heartbeat.ts`) — the narrow slice of `Channel` the proactive loop needs.

## Tests

`test/` at the repo root (Vitest, `test/**/*.test.ts`). Top-level modules covered by
`config.test.ts`, `paths.test.ts`, `logger.test.ts`, `handle.test.ts`, `heartbeat.test.ts`,
`heartbeat-routines.test.ts`. `index.ts`, `dreaming-cron.ts`, `logger.ts` and the two channel
adapters are excluded from coverage thresholds (`vitest.config.ts`) as thin I/O shells.

## Common tasks

| Task | Where |
| --- | --- |
| Add a CLI command | `index.ts` (switch + `printUsage`) |
| Add a config key | `config.ts` (type + `DEFAULTS` + optional env override), then the README table |
| Change admission / mention rules | `handle.ts` (`admit`, `isMentioned`) |
| Change how a message is rendered for the model | `handle.ts` (`formatForModel`) |
| Change typing-indicator behaviour | `handle.ts` (`withTypingIndicator`) + the channel's `sendTyping` |
| Add a proactive behaviour | `heartbeat.ts` (and a store under `agent/`) |
| Change shutdown ordering / drain budget | `index.ts` (`registerShutdown`, `SHUTDOWN_DRAIN_MS` — keep under compose's `stop_grace_period: 30s`) |
| Add a state file | `paths.ts` first, then the module that owns it |

## Notes

- Module headers explain *why* and cite the OpenClaw module they distill. Keep writing them; they
  are the primary in-code documentation.
- `handle.ts` is imported by `heartbeat.ts` (for `withTypingIndicator`) — the dependency points from
  proactive to reactive, not the reverse. Keep it that way to avoid a cycle.
- The WhatsApp process stays alive implicitly (socket + scheduler timers keep the event loop busy)
  until SIGINT/SIGTERM triggers the graceful shutdown registered in `index.ts`. New steps go inside
  `registerShutdown` in the documented order — intake must stop **before** the drain, or
  `drainLocks` chases a moving target.
- Stopping a scheduler only prevents future ticks; an in-flight heartbeat check keeps running, and
  its per-chat turns are covered by `drainLocks` because they run under `withLock`.
