# crablite — Architecture

A map of the code and how a message flows through it.

## Big picture

```
  WhatsApp (baileys, QR)  ─┐
                           ├─►  handle.ts ──►  runTurn (agent/runner.ts) ──►  runAgentLoop (agent/loop.ts)
  CLI REPL (channels/cli) ─┘   admission          build prompt + tools         model ↔ tools ↔ model
                               dedupe/debounce     load session + memory              │
                               NO_REPLY            flush-before-prune                 ▼
                                                                          codex/responses.ts  (Codex Responses API)
                                                                          codex/auth.ts        (OAuth: login/refresh)

  Prompt inputs assembled per turn:
    system-prompt.ts  ◄─ memory/workspace.ts (SOUL/IDENTITY/USER/MEMORY as "# Project Context")
                      ◄─ skills/loader.ts     (<available_skills> catalog, gated by requires.bins)
                      ◄─ agent/tools.ts       (read/write/edit/exec/message/send_file/react/web_fetch)
                      ◄─ memory/search.ts     (memory_search/memory_get)
                      ◄─ agent/reminders.ts   (schedule_reminder)
                      ◄─ agent/schedule-tools.ts (schedule_routine/list_schedules/cancel_schedule)
                      ◄─ agent/subagent.ts    (spawn_subagent)

  Persistence (~/.crablite):
    session/store.ts   sessions.json + <sessionId>.jsonl   (Responses items → resume)
    memory/*.md        the durable, inspectable memory
    memory/.recall.json + memory/dreaming.ts + dreaming-cron.ts   (self-learning)
```

## Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.ts` | CLI entry: `login`, `chat`, `whatsapp`, `dream`, `doctor`. Owns graceful shutdown (`registerShutdown` on SIGINT/SIGTERM: pause intake → stop schedulers → flush pending → drain ≤25s → close socket). |
| `config.ts` | Flat config (`~/.crablite/config.json`) + env overrides. |
| `version.ts` | Client identity: version + `User-Agent`/`originator` constants. |
| `paths.ts` | Resolves the `~/.crablite` layout; dir/secret‑file helpers; bundled resource paths. |
| `logger.ts` | Tiny leveled logger + a silent Baileys logger (avoids a `pino` dependency). |
| `codex/auth.ts` | Codex OAuth: device‑code + PKCE‑paste login, JWT identity, refresh, token storage. |
| `codex/responses.ts` | Codex Responses API client: request shaping, SSE streaming, tool‑call extraction, idle timeout. |
| `agent/tool.ts` | The `Tool`/`ToolContext` contract every tool provider implements. |
| `agent/tools.ts` | The core tools `read/write/edit/exec/message/send_file/react/web_fetch`. |
| `agent/loop.ts` | `runAgentLoop` — the model↔tool primitive; returns final text + new transcript items. |
| `agent/system-prompt.ts` | Ordered system‑prompt assembly (identity→tools→policy→skills→memory→project‑context→runtime). |
| `agent/subagent.ts` | `spawn_subagent` tool + subagent system prompt; isolated child, depth cap. |
| `agent/runner.ts` | `runTurn` — session load (cached), prompt/tool assembly, flush‑before‑prune (deferred onto the chat lock when a `chatId` exists), persist; slash commands. |
| `agent/prune.ts` | Transcript pruning (keep recent items, no orphan tool outputs). |
| `memory/workspace.ts` | Seed + load the bootstrap files; daily‑note helpers; `CONTEXT_FILE_ORDER`. |
| `memory/search.ts` | `memory_search` (lexical) + `memory_get`; records recall signals on daily‑note hits. |
| `memory/recall.ts` | `recall.json` store: recall counts, scores, distinct queries/days. |
| `memory/dreaming.ts` | Rank → gate → rehydrate → promote to `MEMORY.md` → `DREAMS.md`; budget compaction. |
| `memory/flush.ts` | Pre‑prune memory flush: durable facts → today's daily note. |
| `skills/loader.ts` | Scan folders → parse `SKILL.md` frontmatter → gate by `requires.bins` → catalog; tracks self-taught (`learned`) provenance and formats the `crablite doctor` skills listing. |
| `session/store.ts` | `sessions.json` index + append‑only JSONL transcripts (Responses items); in‑process session cache (one shared mutable `Session` per key). |
| `channels/types.ts` | `Channel` + `InboundMessage` interfaces. |
| `channels/whatsapp.ts` | Baileys adapter: QR login, `messages.upsert`, send/sendFile/react/typing/read‑receipts, reconnect; `pauseIntake()` for shutdown (drop inbound, socket stays open). |
| `channels/cli.ts` | Readline REPL exercising the same `runTurn`. |
| `handle.ts` | Shared inbound seam, returned as `InboundHandler = { onInbound, flushPending }`: allowlist, group mention gating, dedupe, per‑chat debounce + serialization; renders sender names (groups) and reply‑quotes for the model; `flushPending` pushes debounce‑pending batches into the lock queue at shutdown. |
| `dreaming-cron.ts` | Nightly scheduler for `runDreaming`; returns a stop handle. |
| `agent/reminders.ts` | Reminder store + `schedule_reminder` tool — crablite's "commitments". At‑least‑once delivery protocol: `claimReminder`/`markDelivered`, stale‑claim retry, attempt cap, terminal `abandonedAt` + `sweepAbandoned`. |
| `agent/routines.ts` | Routine store: recurring schedules (daily/weekly/every), local time, next-run computation. |
| `agent/schedule-tools.ts` | `schedule_routine` + `list_schedules` + `cancel_schedule` (reminders and routines). |
| `heartbeat.ts` | Proactive loop: deliver due reminders (at‑least‑once, whole claim→send→confirm protocol inside one `withLock` scope), run due routines (advance‑first), optional daily `HEARTBEAT.md` check-in; returns a stop handle. |
| `media/stt.ts` | Voice-note transcription via the Codex credential (`gpt-4o-transcribe`); images use Codex directly. |
| `media/files.ts` | Chat file transfer: inbound documents → workspace `inbox/` (dated, sanitized); mimetype guessing + size cap for `send_file`. |
| `net/safe-fetch.ts` | SSRF‑hardened fetch backing `web_fetch`: scheme allowlist, private‑address rejection re‑checked on every redirect, timeout, size cap. |
| `util/lock.ts` | `withLock(key, fn)` — keyed async mutex serializing per‑chat turns across the reactive and proactive paths (and the deferred memory flush). `drainLocks(timeoutMs)` — the shutdown drain: awaits all queued work, re‑sweeping; never rejects. |

> **Per‑directory maps.** Every source directory carries an `index.md` (purpose, entry points, what
> to reuse, anti‑patterns, data contracts, tests, common tasks): `src/index.md`, `src/agent/`,
> `src/channels/`, `src/codex/`, `src/memory/`, `src/session/`, `src/skills/`, `src/media/`,
> `src/net/`, `src/util/`, plus `test/`, `skills/`, `workspace-template/` and `docs/`. Read the
> directory's `index.md` before changing code in it.

## Request lifecycle

1. A channel produces an `InboundMessage` (`chatId`, `senderId`, `senderName`, `chatType`, `text`,
   `quotedText` — the message being replied to, or a media placeholder — plus `reply()`/`sendFile()`).
2. `handle.ts` admits it (allowlist + group mention), marks it read, dedupes by id, debounces rapid
   messages, and serializes per chat, then calls `runTurn` under a typing indicator (re‑asserted
   every ~8s; WhatsApp expires it).
3. `runTurn` (`agent/runner.ts`):
   - loads the session (`session/store.ts`; cached in‑process after the first load) → prior
     Responses items;
   - if the transcript is large, schedules `runMemoryFlush` (durable facts → daily note). In a
     chat this is **deferred off the reply path**: the input is snapshot‑copied and the flush
     throttle recorded at scheduling time, then the flush is queued on `withLock(chatId)` so it
     runs after this reply (FIFO from scheduling). The CLI path (no `chatId`) flushes inline;
   - persists the new user item; builds the pruned model `input`;
   - assembles tools (core + memory + `spawn_subagent`) and the system prompt (skills catalog +
     `# Project Context` from the bootstrap files);
   - calls `runAgentLoop`.
4. `runAgentLoop` (`agent/loop.ts`) posts to the Codex Responses API and loops: stream text →
   collect tool calls → execute tools → feed `function_call_output` back → repeat until no tool
   calls. Returns the final text + all new items.
5. `runTurn` persists the new items and returns `{ replyText, silent }`. `silent` is true for `""`
   or `NO_REPLY`. `handle.ts` delivers `replyText` via `reply()`.

The `message` tool lets the agent send progress mid‑turn; the final `replyText` is the answer.

## Process lifecycle & graceful shutdown

The WhatsApp process stays alive implicitly (socket + scheduler timers keep the event loop busy)
until SIGINT/SIGTERM. `registerShutdown` (`src/index.ts`) then runs, each step error‑isolated so a
failing step can never skip the drain:

1. `channel.pauseIntake()` — no new inbound; the socket stays **open** so draining turns can still
   deliver replies (`pauseIntake` is WhatsApp‑specific, deliberately not on the `Channel`
   interface).
2. Stop the schedulers — `startHeartbeat` and `startDreamingScheduler` return stop handles; an
   in‑flight heartbeat check finishes on its own (its per‑chat turns run under `withLock`, so the
   drain covers them).
3. `handler.flushPending()` — debounce‑pending batches enter the lock queue (they were already
   marked read; dropping them would blue‑tick without replying).
4. `drainLocks(25s)` (`SHUTDOWN_DRAIN_MS`) — awaits in‑flight and queued chat turns *and* work
   queued during the drain (e.g. a deferred memory flush); because a reminder's whole
   claim→send→confirm protocol runs inside one lock scope, the drain also cannot exit between a
   successful send and its confirm. Resolves `false` on timeout, never rejects.
5. `channel.stop()` — cancels any pending reconnect and closes the socket; then `exit(0)`.

A second signal during the drain exits `1` immediately. Docker gives this room:
`stop_grace_period: 30s` in `docker-compose.yml` stays above the internal 25s cap.

## The self‑learning loop (dreaming)

```
memory_search hit on a daily note ──► recall.ts bumps recall.json
                                        (count, maxScore, distinct queries, distinct days)

nightly (dreaming-cron.ts)  ──►  dreaming.ts:
   rank(entries)  = 0.30·relevance + 0.24·frequency + 0.15·diversity + 0.15·recency + 0.16·consolidation
   gate           = score≥0.5 ∧ recalls≥3 ∧ uniqueQueries≥2 ∧ not already promoted
   rehydrate      = re-read the snippet from the live daily file (drop if gone/edited)
   promote        = append to MEMORY.md under "## Promoted From Short-Term Memory (DATE)"
                    with  <!-- crablite-promotion:<key> -->  and  [score= recalls= source=]
   compact        = drop oldest promotion sections if MEMORY.md > ~10k chars (never user content)
   diary          = append a first-person entry to DREAMS.md
   mark           = set promotedAt in recall.json (idempotent)
```

This is the behavior verified in the README's checklist. It needs **no database** — just Markdown and
one JSON file.

## Proactivity, media & startup context

Three faithful additions from OpenClaw, kept minimal:

- **Proactivity** (`agent/reminders.ts` + `agent/routines.ts` + `agent/schedule-tools.ts` +
  `heartbeat.ts`): the agent calls `schedule_reminder` when it commits to a one‑shot follow‑up and
  `schedule_routine` for recurring duties; both land in JSON stores (`reminders.json`,
  `routines.json`) and a per‑minute heartbeat runs due items as short proactive turns in their chat
  (serialized via `withLock`). **Reminder delivery is at‑least‑once**: a two‑phase protocol claims
  the reminder (persisting `deliveringAt` and counting the attempt) *before* sending and confirms
  (`markDelivered`) only *after* a send succeeded — a crash mid‑delivery leaves a persisted claim
  that goes stale after 15 min (`CLAIM_STALE_MS`) and is retried, up to 3 attempts
  (`MAX_DELIVERY_ATTEMPTS`), after which the reminder is stamped `abandonedAt` (terminal: never due
  again, annotated "delivery failed" in `list_schedules`, logged exactly once via the idempotent
  startup/tick sweep). The rich turn falls back to a plain `⏰` text on failure. The accepted trade:
  if a send succeeded but the process died before the confirm, the reminder is delivered **again**
  after restart — a rare duplicate is preferred to a silently lost promise. One cosmetic edge of the
  same bias: if that pre‑confirm crash happened on the *final* attempt, the sweep labels the
  reminder "delivery failed" even though the send landed — deliberately biased against duplicates.
  Routines are the deliberate **contrast**: at‑most‑once per occurrence, because they recur anyway —
  they respect `NO_REPLY` and are advanced **before** running (crash ⇒ skip to next occurrence,
  never double‑run; missed occurrences reschedule from "now", no replay backlog).
  `list_schedules`/`cancel_schedule` manage both. This distills OpenClaw's *commitments → heartbeat delivery* chain (`src/commitments/*`,
  `src/infra/heartbeat-runner.ts`) **and** its cron scheduler + agent cron tool (`src/cron/*`,
  `src/agents/tools/cron-tool.ts`): structured daily/weekly/interval schedules instead of croner
  expressions, chat‑session execution instead of isolated sessions, no delivery/webhook machinery.
  Optionally a once‑daily `HEARTBEAT.md`‑guided check‑in to `CRABLITE_PRIMARY_CHAT`.
- **Media & files** (`channels/whatsapp.ts` `extractMedia`/`sendFile` + `media/stt.ts` +
  `media/files.ts` + `codex/responses.ts` image parts): inbound images become Responses
  `input_image` parts (Codex vision); voice notes are transcribed via the **Codex credential** at
  `<codex-base>/audio/transcriptions` with `gpt-4o-transcribe` (OpenClaw's
  `transcribeOpenAiCodexAudio` — no extra key), and the transcript is persisted to the transcript +
  memory. Inbound **documents** (incl. the `documentWithCaptionMessage` wrapper) are saved to the
  workspace `inbox/` and the model is told the path; extraction is a **skill** (bundled `pdf`, gated
  on `pdftotext`) instead of OpenClaw's pdfjs plugin. Outbound, the `send_file` tool reads a
  workspace file (`resolveInside` containment — tokens are outside the workspace), guesses the
  mimetype and hands it to the channel (`ctx.chatSendFile`, wired like `chatReply`; the heartbeat
  binds `Channel.sendFile` so reminders/routines can deliver files too). One 20 MB cap both ways.
  The live turn carries the image bytes; the stored transcript keeps a text placeholder to avoid
  bloat.
- **Startup context** (`memory/workspace.ts` `loadRecentDailyNotes`): on a fresh session, the last ~2
  days of daily notes are injected as a bounded "## Recent activity" prompt section (OpenClaw's
  `startup-context.ts`), so the agent knows recent events without searching.

## Sessions & persistence

- `sessions.json` maps a stable `sessionKey` (`crablite:<channel>:<chatType>:<chatId>`) to a
  `sessionId` + transcript file.
- The transcript is append‑only JSONL; each line wraps a Responses API item. **Resume = reload the
  items** as the model `input`. Pruning trims what is *sent*, never what is *stored*.
- Sessions are **cached in‑process** after the first load: `loadSession` returns the same mutable
  `Session` object every time, and `appendItems` mutates its `items` in place — so a turn never
  re‑parses the whole transcript. Sound because this process is the only writer and
  `withLock(chatId)` serializes turns; `resetSession` evicts, `resetSessionCache()` exists for
  tests (SessionKey does not include the state dir).

## Auth & model transport

- `codex/auth.ts` implements the ChatGPT/Codex OAuth device‑code flow (with a PKCE browser‑paste
  fallback), stores `{access, refresh, expires, accountId}` in `auth/codex.json` (`0600`), and
  refreshes when within 5 minutes of expiry.
- `codex/responses.ts` POSTs to `https://chatgpt.com/backend-api/codex/responses` with
  `Authorization: Bearer`, `ChatGPT-Account-Id`, and the Responses API body; it parses the SSE stream
  for text deltas and `function_call` items.

## How crablite maps to OpenClaw

| crablite | OpenClaw origin | What changed |
|---|---|---|
| `agent/loop.ts` | `pi-coding-agent` engine + `pi-embedded-runner/run.ts` | Hand‑rolled ~90‑line loop instead of the embedded engine + 2000‑line resilience loop. |
| `agent/system-prompt.ts` | `src/agents/system-prompt.ts` | Same ordered sections, no cache boundary / registry / provider tuning. |
| `memory/*` | `extensions/memory-core`, `src/memory`, `src/agents/workspace.ts` | Same file model + dreaming behavior; lexical search instead of LanceDB/QMD; no wiki/active‑memory. |
| `skills/loader.ts` | `src/agents/skills/*` | Folder + `SKILL.md` + `requires.bins` + catalog; no install managers / 6‑tier precedence. |
| `agent/subagent.ts` | `src/agents/subagent-spawn.ts`, `sessions_spawn` | Native isolated child + depth cap; no ACP, no background/parallel. |
| `channels/whatsapp.ts` | `extensions/whatsapp` (baileys) | Same library + QR flow, ~120 lines instead of ~1000; no gateway/multi‑account. |
| `codex/auth.ts` | `extensions/openai/openai-codex-*` | Device‑code flow ported ~verbatim; no encrypted secret‑ref store / rotation. |
| `session/store.ts` | `src/config/sessions/*` | `sessions.json` + JSONL; single account, no gateway registry. |
| `handle.ts` | `src/auto-reply/*` | Admission + mention + dedupe + debounce + `NO_REPLY`, collapsed. |
| `agent/routines.ts` + `agent/schedule-tools.ts` | `src/cron/*`, `src/agents/tools/cron-tool.ts` | Structured daily/weekly/interval schedules instead of croner expressions; runs in the chat session; flat tool params (same LLM-friendliness lesson). |
| `media/files.ts` + `send_file` + pdf skill | `extensions/document-extract`, `extensions/file-transfer` | Documents saved to plain `inbox/` files + binary-gated skill (`pdftotext`) instead of a pdfjs/canvas plugin; one send tool bound to the current chat. |
| `Dockerfile` / `docker-compose.yml` | root `Dockerfile` / `docker-compose.yml` | One `node:24-slim` stage + baked `gog`; one service, one volume, one command. |

## Security posture

crablite connects an LLM to a shell, the filesystem, the network, and email. The controls (hardened after a security audit):

- **Admission (fail-closed).** `allowFrom` defaults to `[]` — the agent ignores everyone until you list your number(s) (`handle.ts` `admit()`); `"*"` is an explicit, warned opt-in. This is the primary control: only trusted senders reach the agent at all.
- **Filesystem containment — and its honest limit.** One shared helper (`paths.ts` `resolveInside` / `resolveReadable`) confines `write`/`edit`/`exec` cwd/`memory_get`/dreaming-rehydrate to the workspace, and `read` to the workspace **plus the bundled skills dir** (so `SKILL.md` still opens) — never the auth tokens. Be clear about what this buys: the path checks guard against **accidents** (a confused model, a malformed path), **not** against a prompt-injected model. `exec` is arbitrary shell running with the daemon's full privileges — a shell command can read anything the process user can, **including the auth tokens on disk** (`cat ~/.crablite/auth/codex.json` is one tool call away). The real security boundaries are the fail-closed admission allowlist and the container. Running bare-metal grants the agent the operator's full powers on that machine.
- **SSRF-guarded `web_fetch`.** `net/safe-fetch.ts` allows only http/https, rejects private/loopback/link-local/metadata addresses (re-checked on each redirect), times out, and caps the body. Its output is fenced as untrusted **data, not instructions**.
- **Non-root, bounded container.** `USER node`, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit`/`pids_limit`; only `/data` is writable.
- **Concurrency & durability.** All per-chat turns — reactive (`handle.ts`), proactive (`heartbeat.ts`) and the deferred memory flush (`agent/runner.ts`) — serialize through `withLock(chatId)` (`util/lock.ts`), so no two turns write the same session concurrently. Graceful shutdown drains that same lock map (`drainLocks`, ≤25s) after pausing intake, so an in-flight turn is never killed mid-`appendItems`. Token refresh is single-flight (`codex/auth.ts`). All JSON stores write atomically (`writeJsonFileAtomic`, `0600`).
- **Residual, by-design risk.** `exec` is intentionally a real shell (it's how skills act). There is no hard per-command confirmation gate — the boundary is the closed allowlist + Docker sandbox + the untrusted-data policy. Harden further (seccomp/rootless, an `exec` allowlist) if you expose it beyond a single trusted user.
