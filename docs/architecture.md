# crablite — Architecture

A map of the code and how a message flows through it. For *why* it looks like this, read
[`lite_design.md`](lite_design.md); for the OpenClaw source it distills, read
[`openclaw_research.md`](openclaw_research.md).

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
                      ◄─ agent/tools.ts       (read/write/edit/exec/message/web_fetch)
                      ◄─ memory/search.ts     (memory_search/memory_get)
                      ◄─ agent/subagent.ts    (spawn_subagent)

  Persistence (~/.crablite):
    session/store.ts   sessions.json + <sessionId>.jsonl   (Responses items → resume)
    memory/*.md        the durable, inspectable memory
    memory/.recall.json + memory/dreaming.ts + dreaming-cron.ts   (self-learning)
```

## Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.ts` | CLI entry: `login`, `chat`, `whatsapp`, `dream`, `doctor`. |
| `config.ts` | Flat config (`~/.crablite/config.json`) + env overrides. |
| `paths.ts` | Resolves the `~/.crablite` layout; dir/secret‑file helpers; bundled resource paths. |
| `logger.ts` | Tiny leveled logger + a silent Baileys logger (avoids a `pino` dependency). |
| `codex/auth.ts` | Codex OAuth: device‑code + PKCE‑paste login, JWT identity, refresh, token storage. |
| `codex/responses.ts` | Codex Responses API client: request shaping, SSE streaming, tool‑call extraction, idle timeout. |
| `agent/tools.ts` | Tool type + registry; core tools `read/write/edit/exec/message/web_fetch`. |
| `agent/loop.ts` | `runAgentLoop` — the model↔tool primitive; returns final text + new transcript items. |
| `agent/system-prompt.ts` | Ordered system‑prompt assembly (identity→tools→policy→skills→memory→project‑context→runtime). |
| `agent/subagent.ts` | `spawn_subagent` tool + subagent system prompt; isolated child, depth cap. |
| `agent/runner.ts` | `runTurn` — session load, prompt/tool assembly, flush‑before‑prune, persist; slash commands. |
| `agent/prune.ts` | Transcript pruning (keep recent items, no orphan tool outputs). |
| `memory/workspace.ts` | Seed + load the bootstrap files; daily‑note helpers; `CONTEXT_FILE_ORDER`. |
| `memory/search.ts` | `memory_search` (lexical) + `memory_get`; records recall signals on daily‑note hits. |
| `memory/recall.ts` | `recall.json` store: recall counts, scores, distinct queries/days. |
| `memory/dreaming.ts` | Rank → gate → rehydrate → promote to `MEMORY.md` → `DREAMS.md`; budget compaction. |
| `memory/flush.ts` | Pre‑prune memory flush: durable facts → today's daily note. |
| `skills/loader.ts` | Scan folders → parse `SKILL.md` frontmatter → gate by `requires.bins` → catalog. |
| `session/store.ts` | `sessions.json` index + append‑only JSONL transcripts (Responses items). |
| `channels/types.ts` | `Channel` + `InboundMessage` interfaces. |
| `channels/whatsapp.ts` | Baileys adapter: QR login, `messages.upsert`, send, reconnect. |
| `channels/cli.ts` | Readline REPL exercising the same `runTurn`. |
| `handle.ts` | Shared inbound seam: allowlist, group mention gating, dedupe, per‑chat debounce + serialization. |
| `dreaming-cron.ts` | Nightly scheduler for `runDreaming`. |
| `agent/reminders.ts` | Reminder store + `schedule_reminder` tool — crablite's "commitments". |
| `heartbeat.ts` | Proactive loop: deliver due reminders + optional daily `HEARTBEAT.md` check-in. |
| `media/stt.ts` | Voice-note transcription via the Codex credential (`gpt-4o-transcribe`); images use Codex directly. |

## Request lifecycle

1. A channel produces an `InboundMessage` (`chatId`, `senderId`, `chatType`, `text`, `reply()`).
2. `handle.ts` admits it (allowlist + group mention), dedupes by id, debounces rapid messages, and
   serializes per chat, then calls `runTurn`.
3. `runTurn` (`agent/runner.ts`):
   - loads the session (`session/store.ts`) → prior Responses items;
   - if the transcript is large, runs `runMemoryFlush` first (durable facts → daily note);
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

- **Proactivity** (`agent/reminders.ts` + `heartbeat.ts`): the agent calls `schedule_reminder` when it
  commits to a follow‑up; the reminder lands in `reminders.json`; a per‑minute heartbeat delivers due
  ones by running a short proactive turn in that chat. Optionally a once‑daily `HEARTBEAT.md`‑guided
  check‑in to `CRABLITE_PRIMARY_CHAT`. This is OpenClaw's *commitments → heartbeat delivery* chain
  (`src/commitments/*`, `src/infra/heartbeat-runner.ts`) with explicit (tool‑driven) extraction.
- **Media** (`channels/whatsapp.ts` `extractMedia` + `media/stt.ts` + `codex/responses.ts` image
  parts): inbound images become Responses `input_image` parts (Codex vision); voice notes are
  transcribed via the **Codex credential** at `<codex-base>/audio/transcriptions` with
  `gpt-4o-transcribe` (OpenClaw's `transcribeOpenAiCodexAudio` — no extra key), and the transcript is
  persisted to the transcript + memory. The live turn carries the image bytes; the stored transcript
  keeps a text placeholder to avoid bloat.
- **Startup context** (`memory/workspace.ts` `loadRecentDailyNotes`): on a fresh session, the last ~2
  days of daily notes are injected as a bounded "## Recent activity" prompt section (OpenClaw's
  `startup-context.ts`), so the agent knows recent events without searching.

## Sessions & persistence

- `sessions.json` maps a stable `sessionKey` (`crablite:<channel>:<chatType>:<chatId>`) to a
  `sessionId` + transcript file.
- The transcript is append‑only JSONL; each line wraps a Responses API item. **Resume = reload the
  items** as the model `input`. Pruning trims what is *sent*, never what is *stored*.

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
| `agent/system-prompt.ts` | `src/agents/system-prompt.ts` (657+) | Same ordered sections, no cache boundary / registry / provider tuning. |
| `memory/*` | `extensions/memory-core`, `src/memory`, `src/agents/workspace.ts` | Same file model + dreaming behavior; lexical search instead of LanceDB/QMD; no wiki/active‑memory. |
| `skills/loader.ts` | `src/agents/skills/*` | Folder + `SKILL.md` + `requires.bins` + catalog; no install managers / 6‑tier precedence. |
| `agent/subagent.ts` | `src/agents/subagent-spawn.ts`, `sessions_spawn` | Native isolated child + depth cap; no ACP, no background/parallel. |
| `channels/whatsapp.ts` | `extensions/whatsapp` (baileys) | Same library + QR flow, ~120 lines instead of ~1000; no gateway/multi‑account. |
| `codex/auth.ts` | `extensions/openai/openai-codex-*` | Device‑code flow ported ~verbatim; no encrypted secret‑ref store / rotation. |
| `session/store.ts` | `src/config/sessions/*` | `sessions.json` + JSONL; single account, no gateway registry. |
| `handle.ts` | `src/auto-reply/*` | Admission + mention + dedupe + debounce + `NO_REPLY`, collapsed. |
| `Dockerfile` / `docker-compose.yml` | root `Dockerfile` / `docker-compose.yml` | One `node:24-slim` stage + baked `gog`; one service, one volume, one command. |

## Security posture

crablite connects an LLM to a shell, the filesystem, the network, and email. The controls (hardened after a security audit):

- **Admission (fail-closed).** `allowFrom` defaults to `[]` — the agent ignores everyone until you list your number(s) (`handle.ts` `admit()`); `"*"` is an explicit, warned opt-in. This is the primary control: only trusted senders reach the agent at all.
- **Filesystem containment.** One shared helper (`paths.ts` `resolveInside` / `resolveReadable`) confines `write`/`edit`/`exec` cwd/`memory_get`/dreaming-rehydrate to the workspace, and `read` to the workspace **plus the bundled skills dir** (so `SKILL.md` still opens) — never the auth tokens.
- **SSRF-guarded `web_fetch`.** `net/safe-fetch.ts` allows only http/https, rejects private/loopback/link-local/metadata addresses (re-checked on each redirect), times out, and caps the body. Its output is fenced as untrusted **data, not instructions**.
- **Non-root, bounded container.** `USER node`, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit`/`pids_limit`; only `/data` is writable.
- **Concurrency & durability.** All per-chat turns — reactive (`handle.ts`) and proactive (`heartbeat.ts`) — serialize through `withLock(chatId)` (`util/lock.ts`), so no two turns write the same session concurrently. Token refresh is single-flight (`codex/auth.ts`). All JSON stores write atomically (`writeJsonFileAtomic`, `0600`).
- **Residual, by-design risk.** `exec` is intentionally a real shell (it's how skills act). There is no hard per-command confirmation gate — the boundary is the closed allowlist + Docker sandbox + the untrusted-data policy. Harden further (seccomp/rootless, an `exec` allowlist) if you expose it beyond a single trusted user.
