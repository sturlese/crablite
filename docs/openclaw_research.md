# OpenClaw — Deep Research (Phase 1)

> Goal of this document: understand **what OpenClaw actually is**, identify **what constitutes its core / essence**, and decide **what is accessory complexity** — so that Phase 2 can design a much smaller, faithful "OpenClaw Lite".
>
> Method: a structured read of the real repository at `/Users/marc/dev/openclaw` (commit on `main`, `github.com/openclaw/openclaw`). The repo is huge — ~8,000 TS files in `src/`, ~5,400 in `extensions/`, plus native Swift/Kotlin apps. Findings below are grounded in concrete files; references use `path:line` relative to the repo root. This is a distillation, not a summary of every file.

---

## 0. What OpenClaw is, in one paragraph

OpenClaw is a **personal AI assistant platform**. A single long-running agent lives on messaging channels (Telegram, Discord, Slack, WhatsApp, …), remembers things by **writing Markdown files to disk**, learns which of those notes matter and **promotes them into durable memory automatically ("dreaming")**, extends its abilities by **dropping skill folders** into a directory, drives external tools mostly by **shelling out to CLIs**, can **spawn subagents** for delegated work, and authenticates to model providers with **OAuth (including ChatGPT/Codex)**. The whole thing is packaged to run under Docker. Its design north star, stated verbatim in its root `AGENTS.md:4`, is:

> **"Skills own workflows; root owns hard policy and routing."**

And its memory philosophy, `docs/concepts/memory.md:9`:

> **"OpenClaw remembers things by writing plain Markdown files… The model only 'remembers' what gets saved to disk — there is no hidden state."**

Those two sentences are the essence. Everything the Lite version must preserve flows from them.

The project is crab/claw-themed (`clawd`, `crabbox`, `clawhub`, `clawsweeper`). Product name is **OpenClaw**; CLI/package/paths/config use `openclaw`; state lives in `~/.openclaw`.

---

## 1. The single most important architectural fact

**OpenClaw does not implement the LLM agent loop itself.** The model→tool→model turn loop lives inside an embedded engine, **`@earendil-works/pi-coding-agent`** ("Pi"), with types from `@earendil-works/pi-agent-core` (`src/agents/pi-embedded-runner/run/attempt.ts:5`, `src/types/pi-agent-core.d.ts:1`). Pi supplies:

- the session engine (`createAgentSession`, `AgentSession`, `SessionManager`),
- the canonical `Skill` type and the base coding tools (`createCodingTools`, `createReadTool`, `src/agents/pi-tools.ts:1`),
- JSONL transcript persistence during a live run ("Pi owns JSONL persistence").

**Everything OpenClaw adds is a wrapper** around Pi: discovery/gating of skills, prompt assembly, the tool *policy* layer, channels & I/O, memory, subagents, auth/resilience, and persistence bookkeeping. Concretely, `src/agents/pi-embedded-*` is the adapter that (1) builds a system prompt + tool set + history, (2) calls `session.prompt()`, and (3) **observes** Pi's typed event stream (`message_*`, `tool_execution_*`, `agent_*`, `compaction_*`) to stream chunks out and run hooks — it does **not** drive the tool loop (`src/agents/pi-embedded-subscribe.handlers.ts:76-142`).

**Implication for Lite.** The "loop" is small and delegable. A faithful Lite either (a) reuses an agent-loop library, or (b) hand-rolls ~150 lines of a tool-calling loop against the model API. Because our only required auth is **Codex OAuth → OpenAI Responses API** (`https://chatgpt.com/backend-api/codex`, §13), and Pi is an opaque external dependency that may not speak that transport, **hand-rolling a tiny Responses-API loop is the cleaner, more inspectable choice** for a small codebase. (Decision finalized in Phase 2.)

---

## 2. Architecture at a glance

```
                      ┌──────────────── channels (plugins) ────────────────┐
  WhatsApp (baileys)  │  Telegram   Discord   Slack   …   CLI/TUI (dev)     │
                      └───────────────┬─────────────────────────────────────┘
                                      │ normalized inbound message
                                      ▼
                            ┌─────────────────────┐
                            │  Gateway (daemon)   │  hosts each account,
                            │  server-channels.ts │  auto-restart w/ backoff
                            └──────────┬──────────┘
                                       ▼  admission: allowlist / mention / DM policy
                            ┌─────────────────────┐
                            │  Auto-reply seam     │  getReplyFromConfig →
                            │  get-reply.ts        │  resolve session/agent/model
                            └──────────┬──────────┘
                                       ▼
                     ┌───────────────────────────────────┐
                     │  Embedded runner (runEmbeddedPi…)  │  OUTER resilience loop
                     │  pi-embedded-runner/run.ts         │  (retry/failover/compaction)
                     └──────────────┬────────────────────┘
                                    ▼
                  ┌───────────────────────────────────────────┐
                  │  Pi engine: createAgentSession/.prompt()   │  INNER agent loop
                  │  model → tools → model → …                 │  (owns the real loop)
                  └───────────────────────────────────────────┘
                                    │  builds inputs from ▼
   system prompt (system-prompt.ts) + bootstrap files (SOUL/IDENTITY/USER/MEMORY…)
   + skills catalog (progressive disclosure) + tool set (policy-filtered) + history (JSONL)

  State on disk (~/.openclaw):
    openclaw.json · agents/<id>/{agent/auth-profiles.json, sessions/…} · credentials/
    workspace/ (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, DREAMS.md, memory/*.md)
```

Design tenets from `AGENTS.md:26-48`: **core stays plugin-agnostic** (no bundled ids/defaults in core; plugins cross in only via `openclaw/plugin-sdk/*`); **channels are implementation** under `src/channels/**` while providers own auth/catalog; **hot paths carry prepared facts forward** (don't rediscover provider/model/channel each request); **deterministic ordering** for prompt-cache friendliness.

---

## 3. Execution flow

**Request lifecycle** (two ingress families converge on one runner):

- *Messaging:* channel → `dispatchInboundMessage` (`src/auto-reply/dispatch.ts:244`) → `getReplyFromConfig` (`src/auto-reply/reply/get-reply.ts:203`) → `runReplyAgent` → `runEmbeddedPiAgent` (`src/agents/pi-embedded-runner/run.ts:365`).
- *Command/CLI/RPC/boot:* `agentCommand` / `agentCommandFromIngress` (`src/agents/agent-command.ts:1416,1444`) → `runAgentAttempt` → `runEmbeddedPiAgent`.

**Two nested loops:**

- **Inner (Pi, the real one):** `session.prompt()` calls the model, streams tokens, detects tool calls, executes each tool's `execute()`, feeds results back, repeats until no tool is requested, resolves. OpenClaw *observes* via `session.subscribe()`.
- **Outer (OpenClaw resilience, `run.ts:1192` `while(true)`):** rebuilds an auth/runtime plan each attempt and retries for provider failover, key rotation, rate-limit backoff, empty/reasoning-only responses, context overflow→compaction, and idle timeouts. Bounded by `MAX_RUN_LOOP_ITERATIONS` (`base 24 + profiles×8`, clamped `[32,160]`). This outer loop is ~2,000 lines and is **mostly accessory**.

**Sessions / runs / attempts.** A *session* is a durable, keyed conversation (`sessions.json` maps `sessionKey → {sessionId, sessionFile, …}`, `src/config/sessions/paths.ts:35`); its transcript is **append-only JSONL, one file per `sessionId`**, a parent-linked tree of `{type:"message", id, parentId, message}` lines. **Resume = reopen the JSONL** (`SessionManager.open(sessionFile)`) and append the new user prompt, so the model sees full history. Session keys: `agent:<id>:<channel>:<peerKind>:<peerId>` (direct chats collapse to `agent:<id>:<mainKey>`). A *run* is one prompt (≤1 active per session); an *attempt* is one iteration of the outer loop.

**Turn bounding (defense in depth):** per-run wall clock (default **48h**, `src/agents/timeout.ts:3`), **LLM idle watchdog (~120s with no token)**, outer retry cap, compaction-attempt breakers, and session lifetime reset (daily at hour 4, or after idle).

**Auto-reply (whether to respond):**
- *Admission* (upstream): DM allow/deny, group sender allowlist, `requireMention` (defaults **true** in groups), command auth — `src/channels/message-access/`, `src/channels/mention-gating.ts:104`.
- *Debounce/batching:* an inbound debouncer coalesces rapid same-sender messages (`src/auto-reply/inbound-debounce.ts:58`); an in-flight message steers the running session (`session.steer()`) instead of racing.
- *Silent reply:* the agent emits exactly **`NO_REPLY`** (`src/auto-reply/tokens.ts:4`) to suppress delivery; a policy makes DMs *must-reply* by default and groups allow-silence.

---

## 4. Context construction & the system prompt

The assembler is `buildAgentSystemPrompt` (`src/agents/system-prompt.ts:657`). It emits one string split by a **cache boundary** into a stable prefix (LRU-cached) and a per-turn dynamic suffix. Ordered sections (abridged): identity line → `## Tooling` (from a fixed `{name: summary}` map ∩ available tools) → `## Execution Bias` → `## Safety` → `## Skills` (the `<available_skills>` catalog) → `## Memory Recall` (guidance only) → `## Workspace` → **`# Project Context`** (the *contents* of the bootstrap files) → `## Runtime` footer.

**Bootstrap context files** are the mechanism that puts soul/identity/memory into the prompt. A fixed set of workspace Markdown files (`src/agents/workspace.ts:21-28`) is loaded each run and rendered under `# Project Context` as `## <name>\n\n<body>`, **sorted by a fixed order** (`CONTEXT_FILE_ORDER`, `system-prompt.ts:49-57`):

| order | file | role |
|---|---|---|
| 10 | `AGENTS.md` | operating instructions / policy |
| 20 | `SOUL.md` | persona & tone (optional) |
| 30 | `IDENTITY.md` | structured self-identity (name, emoji, vibe) |
| 40 | `USER.md` | durable facts about the human |
| 50 | `TOOLS.md` | tool notes |
| 60 | `BOOTSTRAP.md` | one-shot onboarding guidance |
| 70 | `MEMORY.md` | long-term durable memory |
| (dynamic) | `HEARTBEAT.md` | placed below the cache boundary |

Each file is budgeted (per-file ~12k chars, total ~60k, with head/tail trimming) so the prompt can't blow up. Missing files are skipped.

**The context-engine (`src/context-engine/`) is a no-op in the default path.** It's a plugin-swap registry whose default `LegacyContextEngine` passes messages through unchanged; real assembly is in `system-prompt.ts`. **Verdict: accessory — delete it in Lite.** Likewise the cache-boundary/LRU/hashing is a provider prompt-cache micro-optimization, and the second bootstrap cache layer is redundant.

**Bounding context growth** happens two ways (keep *one* in Lite): transcript **pruning** (`src/agents/pi-hooks/context-pruning/pruner.ts` — never prune before the first user message, only trim "prunable" tool results, keep last N assistant turns) *or* LLM **compaction** (summarize old turns). The pruner is cheaper and dependency-free.

---

## 5. Memory: the file-based model

This is one of the two things that make OpenClaw special, and the user explicitly wants it preserved. Everything durable is **plain Markdown in the workspace dir** (default `~/.openclaw/workspace`); the only non-Markdown is dreaming's machine-state JSON. There is **no hidden DB state** — DB backends (LanceDB/QMD/SQLite-FTS), when present, are *just search indexes over the same files*.

**Two tiers + identity files:**

- **Long-term:** `MEMORY.md` — curated durable facts/prefs/decisions. Injected **verbatim into every session** (order 70). This is the promotion target for dreaming. Canonical filename in `src/memory/root-memory-files.ts:4`.
- **Daily / working / short-term:** `memory/YYYY-MM-DD.md` (and slugged `-<slug>.md`). Agent-written, **searchable but not injected wholesale**; recent days may be injected as *untrusted* startup context.
- **Identity trio:** `SOUL.md` (persona/tone), `IDENTITY.md` (structured self — schema at `src/agents/identity-file.ts:6-13`), `USER.md` (facts about the human) — injected verbatim, fixed order, before `MEMORY.md`.
- **`DREAMS.md`:** a human-readable diary of what got learned and why.

**Read path = two tools** (`extensions/memory-core`): `memory_search` (search `MEMORY.md` + `memory/*.md` + transcripts) and `memory_get` (bounded excerpt read). The `## Memory Recall` prompt section injects **only guidance** ("search before answering about prior work"), never file contents.

**Write path.** The agent writes daily notes with normal file tools. Crucially, **before conversation compaction a silent "memory-flush" turn runs** (`extensions/memory-core/src/flush-plan.ts:13-40`) that appends durable content to `memory/YYYY-MM-DD.md` and treats `MEMORY.md`/`SOUL.md`/`AGENTS.md` as read-only. This prevents context loss and feeds the learning loop.

**`MEMORY.md` size compaction:** on each promotion, `compactMemoryForBudget` (`memory-budget.ts:116-164`, ~10k char budget) drops the **oldest** `## Promoted From Short-Term Memory (DATE)` sections first; **user-authored content is preserved unconditionally**.

**Accessory to drop:** LanceDB/vector/QMD/Honcho backends, `memory-wiki` (a heavy provenance vault with `wiki_*` tools), multimodal embeddings, and `active-memory` (a pre-reply recall *subagent* that's a nice latency optimization but pure orchestration — Lite can let the model call `memory_search` inline).

---

## 6. Self-learning: "dreaming" (the crown jewel)

OpenClaw's memory **evolves itself**. Frequently-recalled, high-relevance daily notes graduate into always-loaded `MEMORY.md`, with provenance and a human-readable diary. This is the behavior the user wants preserved (not necessarily the exact implementation). It is **opt-in, off by default**. Engine: `extensions/memory-core/src/dreaming.ts` + `dreaming-phases.ts` + `short-term-promotion.ts`.

The loop, distilled:

1. **Continuous signal capture.** Every `memory_search` records a hit into `memory/.dreams/short-term-recall.json` — *but only if the hit came from a daily/short-term file* (not from `MEMORY.md` itself). Each entry accumulates `recallCount`, score stats, distinct query hashes, and distinct recall days (`short-term-promotion.ts:934-1045`).
2. **Trigger.** One nightly cron ("Memory Dreaming Promotion", default `0 3 * * *`) runs an isolated sweep.
3. **Rank.** Candidates are scored by a weighted blend (`short-term-promotion.ts:56-64`): relevance 0.30, frequency 0.24, diversity 0.15, recency 0.15 (14-day half-life), consolidation 0.10 (multi-day recurrence), conceptual 0.06.
4. **Promote.** Items passing gates (`minScore 0.75`, `minRecallCount 3`, `minUniqueQueries 2`) are **rehydrated from the live daily file** (so stale/edited lines never promote), then appended to `MEMORY.md` under `## Promoted From Short-Term Memory (DATE)`, each bullet carrying an **idempotency marker** `<!-- openclaw-memory-promotion:<key> -->` and `[score= recalls= source=path:lines]` provenance (`applyShortTermPromotions`, `short-term-promotion.ts:1614-1766`).
5. **Diary.** A first-person entry is written to `DREAMS.md`.

(There are also "light" and "REM" phases that only nudge scores — accessory. The **deep promotion loop alone captures the philosophy**.)

**This entire loop needs zero database** — plain Markdown + one JSON recall file. That is exactly why it fits a Lite version.

---

## 7. Skills system

A skill is **a folder containing `SKILL.md`** (optionally `scripts/`, `references/`). This is the "add a skill by creating a folder" property the user wants. Contract (documented in `skills/skill-creator/SKILL.md`, enforced in `src/agents/skills/`):

- **Frontmatter:** `name` (required), `description` (required — the *only* per-skill text the model sees up front; the trigger signal), optional `metadata.openclaw` with `emoji`, `requires: { bins?, anyBins?, env?, config? }`, and `install: [...]` specs (brew/npm/go/uv/download). Missing `name`/`description` ⇒ the folder is skipped.
- **Body:** Markdown instructions, **loaded on demand** — progressive disclosure.
- **What it contributes:** primarily *instructions that drive existing tools* (`exec`/`bash`, `read`, `curl`) plus an external CLI declared via `requires`/`install`. It is **not** a code plugin (e.g. `weather` just shells `curl wttr.in`; `gog` documents the `gog` CLI).

**Discovery:** several roots are scanned and merged by skill name (`src/agents/skills/workspace.ts:606`) — bundled `skills/`, managed `$CONFIG_DIR/skills`, personal `~/.agents/skills`, project `<ws>/.agents/skills`, workspace `<ws>/skills`. Dropping a folder into any is all it takes.

**Gating:** `shouldIncludeSkill` (`config.ts:73`) hides a skill whose `requires.bins` aren't on `PATH` (or wrong OS/env). So `gog` simply disappears if the `gog` binary isn't installed — cheap and high-value.

**Presentation:** `formatSkillsForPrompt` (`skill-contract.ts:44`) emits an `<available_skills>` catalog of `<name><description><location>` **only** — never the bodies. The `## Skills` section tells the model: *"Scan `<available_skills>`; if one applies, read its `SKILL.md` at `<location>` with the `read` tool, then follow it."* **Activation is just the `read` tool** — there is no separate activation RPC.

**Accessory to drop:** install managers (`clawhub`, brew/npm/go/uv runners), the 6-tier precedence + symlink-escape hardening, snapshot caching, compact-format budgeting. Keep folder→`SKILL.md` scan + `requires.bins` check + catalog injection.

---

## 8. Tools system

Two layers in the original: a *descriptor/planning* layer (`src/tools/`, `ToolDescriptor` with JSON-schema `inputSchema`, `owner`/`executor` unions over `core|plugin|channel|mcp`, and an `availability` expression tree) and the *runtime tool objects* (`src/agents/pi-tools.ts`, shape `{name, description, parameters, execute(id, args)}`). A per-session **policy pipeline** filters by profile (`minimal|coding|messaging|full`) / allow / deny before the model sees the set.

Core built-ins (`src/agents/tool-catalog.ts`): **fs** `read/write/edit/apply_patch`, **runtime** `exec/process`, **web** `web_search/web_fetch`, **memory** `memory_search/memory_get`, **sessions** `sessions_spawn/sessions_yield/subagents`, plus `message` (channel send). Message delivery **is a tool** — which is how the runner detects "the reply was already sent" and suppresses a redundant final text.

**Lite:** collapse to one tiny registry `Map<name, {name, description, parameters, execute}>`; seed `read/write/edit/exec`, `message`, `memory_search/memory_get`, `spawn_subagent`. Skip the descriptor/executor indirection and availability tree (an optional single `available?()` predicate is enough).

---

## 9. Subagents

**The main agent can spawn subagents autonomously** — `sessions_spawn` is a normal model-facing tool (`src/agents/tools/sessions-spawn-tool.ts:251`), included in the `coding` profile. No user command is required (a separate `subagents` tool with `list|steer|kill` exists for control only).

Two runtimes: `runtime:"subagent"` (**native, in-process**, `spawnSubagentDirect`, `src/agents/subagent-spawn.ts:691`) and `runtime:"acp"` (external harness — codex/claude/gemini — over the Agent Client Protocol, a 1,500-line module). The child gets its **own session key** (`agent:<id>:subagent:<uuid>`), its **own system prompt** (`buildSubagentSystemPrompt`, `subagent-system-prompt.ts:4` — "complete the task in the first `[Subagent Task]` message; your final message is reported to the parent; don't poll"), an **isolated context** by default (or `fork` of the parent transcript), and inherited/limited tools. Guardrails: **max spawn depth**, max children per agent, target allowlist, sandbox-inheritance rule, and role gating `main → orchestrator → leaf` (a leaf can't spawn).

**When to spawn** (what the model reads): *"Spawn a clean isolated session by default when the work should happen in a fresh child session… give a clear objective/output/write-scope/verification brief and a `taskName`; `context:"fork"` only when the child needs the current transcript; `sessions_yield` to wait."*

**Lite:** register `spawn_subagent` as a tool that (1) checks a **depth cap**, (2) builds a subagent system prompt, (3) reuses the *same* agent loop with an isolated history and `[Subagent Task]` first message, (4) returns the child's final message synchronously. Drop ACP entirely; add push-based/parallel children later if ever needed.

---

## 10. Channels & interfaces

**Channel contract** (`src/channels/plugins/types.plugin.ts:61`): a bag of optional adapters; the load-bearing ones are `config`, `gateway.startAccount(ctx)` (the long-running inbound listener), `outbound` (send), and `auth.login`. All channels funnel normalized inbound messages into the **one shared agent seam** (`getReplyFromConfig`). Basic safety = allowlists (`allow-from.ts`, `*` wildcard) + inbound dedupe.

**WhatsApp** (`extensions/whatsapp/`) uses **`baileys` `7.0.0-rc11`** (`package.json:12`), the multi-device WhatsApp-Web library. Auth = **QR "Linked Devices" only** (no phone pairing-code path): `useMultiFileAuthState(dir)` persists `creds.json` (atomic, mode `0600`, with a `.bak`), the QR arrives on `connection.update`, and `loggedOut(401)` clears creds to force re-link. Inbound = `sock.ev.on("messages.upsert")` → normalize → **dedupe by message id** → debounce → agent seam. Outbound = `sock.sendMessage(jid, {text|media})`. Reconnect is exponential-backoff.

**CLI / dev loop.** The launcher is `openclaw.mjs` → `src/entry.ts` → a Commander program. The local dev chat is `openclaw chat`/`tui` with an **embedded (in-process) backend** (`src/tui/embedded-backend.ts`) that runs the agent with **no gateway and no channel** — the debugging REPL. To exercise WhatsApp locally: `openclaw channels login --channel whatsapp` (scan QR) then `openclaw gateway run`.

**Lite:** a single `Channel` interface `{ id, start(onInbound), stop() }` with an `InboundMessage` carrying `reply()`. Implement two: a `baileys` WhatsApp adapter (QR flow) and a `readline` CLI adapter. Both satisfy the same interface and hit the same `handleInbound`. No gateway daemon, no registry, one account.

---

## 11. Persistence, config & state

**State dir** resolves from `OPENCLAW_STATE_DIR` else `~/.openclaw` (`src/config/paths.ts:60-89`). Layout: `openclaw.json` (config, `0600`, with `.bak` rotation), `agents/<id>/agent/auth-profiles.json` (model auth), `agents/<id>/sessions/`, `credentials/` (channel + encrypted OAuth material), `workspace/` (the Markdown memory files), plus `logs/ memory/ cron/ locks/`.

**Config** (`openclaw.json`, JSON/JSON5): env always overrides. The zod schema is ~930 lines of mostly-optional surface; the **essential** keys are just `agents.defaults.model(s)` + `auth.profiles` (metadata only — provider + mode, never the secret) + optional `models.providers`. Everything else (TTS personas, media understanding, per-surface queues, browser profiles) is accessory.

**Auth profiles:** `auth-profiles.json = {version, profiles: {id: cred}}` with cred variants `api_key | token | oauth`; `oauth` = `{access, refresh, expires, email?, accountId?, …}`. For `openai-codex`, tokens are stored **out-of-line and AES-256-GCM-encrypted** in `credentials/auth-profiles/<hash>.json`, keyed from a machine seed (env / macOS Keychain / generated key file). A file lock (`locks/oauth-refresh/<hash>`) serializes refresh to avoid `refresh_token_reused` storms.

**Lite:** single agent, no encryption. `~/.<app>/config.json` (`{model}`) + `~/.<app>/auth/codex.json` (`{access, refresh, expires, accountId}`, `0600`) + `~/.<app>/workspace/` + `~/.<app>/sessions/`. Skip zod (a hand type + `JSON.parse`), rotation, secret-ref indirection, and at-rest encryption (a `0600` file is enough).

---

## 12. Codex OAuth (the only auth we need)

The `openai-codex` provider (`extensions/openai/`) offers three login methods; we only need one. Constants: auth base **`https://auth.openai.com`**, client id **`app_EMoamEEZ73f0CkXaXp7hrann`**, model transport base **`https://chatgpt.com/backend-api/codex`** (`extensions/openai/base-url.ts:3`) — i.e. the **OpenAI Responses API** backed by a ChatGPT subscription (identical to the OpenAI Codex CLI).

**Fully in-repo (portable verbatim): the device-code + PKCE flow** (`openai-codex-device-code.ts`):
1. `POST /api/accounts/deviceauth/usercode {client_id}` → `{device_auth_id, user_code, interval}`.
2. Show `auth.openai.com/codex/device` + `user_code`.
3. Poll `POST /api/accounts/deviceauth/token` until success → `{authorization_code, code_verifier}`.
4. Exchange `POST https://auth.openai.com/oauth/token` (form: `grant_type=authorization_code, code, code_verifier, client_id, redirect_uri`) → `{access_token, refresh_token, expires_in}`.

**Identity:** base64url-decode the access-token JWT to get `accountId` (`chatgpt_account_id`), `email`, `exp` (`openai-codex-auth-identity.ts:29-100`).

**Refresh:** lazily, when `expires - now ≤ 5 min` (`DEFAULT_OAUTH_REFRESH_MARGIN_MS`), via `POST /oauth/token {grant_type:"refresh_token", client_id, refresh_token}`.

**Request attach:** `Authorization: Bearer <access>`, `ChatGPT-Account-Id: <accountId>`, plus attribution headers `originator` / `User-Agent`. POST to `https://chatgpt.com/backend-api/codex/responses` with the Responses-API request shape (streamed SSE).

**Lite:** a ~150-line `codex-auth.ts` implementing login (device-code) + `getAccessToken()` (refresh-on-expiry) + `attach(headers)`. This is the *entire* auth story.

---

## 13. Containerization & Google integration

**Docker (original):** a heavy 5-stage build (`Dockerfile`, Bun+pnpm, native addons, canvas/UI/qa builds, 137 bundled extensions, optional Chromium). `docker compose up` runs a `gateway` + on-demand `cli` service, mounting `~/.openclaw` as a volume. **Almost all of this is accessory.** A minimal equivalent: `node:24-slim` + `ca-certificates curl git tini` + `pnpm install` + build + **one service, one state volume, one port**.

**Google (the decisive finding):** Gmail/Sheets do **not** come from `extensions/google` (that's the *Gemini model provider*). They come **entirely from the `gog` CLI wrapped as a skill** (`skills/gog/SKILL.md`). The agent shells out to `gog gmail …` / `gog sheets …`. OAuth is `gog`-managed: `gog auth credentials client_secret.json` then `gog auth add you@gmail.com --services gmail,sheets`; tokens live in `gog`'s encrypted keyring. **Send-confirmation is a soft prompt rule, not a code gate** — the safe pattern is **draft → confirm → send** (`gog gmail drafts create` → user confirms → `gog gmail drafts send <id>`). The `gog` binary is Go; the container recipe bakes the Linux binary at build time.

**Lite decision (Phase 2):** wrap `gog` as a skill (faithful, zero OAuth code) *or* implement a tiny `googleapis`-based Gmail+Sheets tool set (no external binary). Trade-off captured in the research; recommendation leans to `gog` for faithfulness, with `googleapis` as the Node-pure alternative.

---

## 14. What is the CORE (the essence to preserve)

Ranked by how much they define "feeling like OpenClaw":

1. **File-based, inspectable memory** — `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` (long-term, always injected) + `memory/YYYY-MM-DD.md` (daily). No hidden state. *(The philosophy.)*
2. **Self-learning via "dreaming"** — recall-tracking → nightly ranked promotion of daily notes into `MEMORY.md`, with provenance + a `DREAMS.md` diary. Zero DB.
3. **Skills as folders** — `SKILL.md` frontmatter (`name`/`description`/`requires`) + progressive-disclosure catalog + activation by reading the file. `requires.bins` gating.
4. **A small tool set the agent drives** — `read/write/edit/exec`, `message`, `memory_search/get`, and shelling out to CLIs (the skill pattern).
5. **Autonomous subagents** — a `spawn_subagent` tool with an isolated child, a subagent system prompt, and a depth cap.
6. **The agent turn loop** — model → tools → model, streamed out in chunks, with `NO_REPLY` silent handling and an idle-timeout backstop.
7. **Ordered context assembly** — bootstrap files rendered under `# Project Context` in the fixed SOUL→IDENTITY→USER→MEMORY order, budgeted.
8. **WhatsApp as primary channel + a CLI dev loop** — one `Channel` interface; `baileys` QR auth; an in-process REPL for debugging.
9. **Codex OAuth** — device-code login + refresh + `Bearer`/`ChatGPT-Account-Id` attach to the Responses API.
10. **Docker-first** — one `docker compose up`.

---

## 15. What I would eliminate (accessory) and why

| Area | Drop | Why it's not the essence |
|---|---|---|
| Engine | Hard dependency on Pi's full outer resilience loop, live model-switch, prompt-cache observability | Operational hardening, not agent semantics; a tiny retry + idle timeout suffices |
| Context | `context-engine/` registry/delegate/legacy + cache-boundary LRU + 2nd bootstrap cache | No-op in default path; pure plugin-swap indirection + micro-optimizations |
| Memory | LanceDB/vector/QMD/Honcho, `memory-wiki`, multimodal embeddings, `active-memory` | Interchangeable search indexes / orthogonal vault / latency optimizations over the same files |
| Dreaming | Light & REM phases, phase-signals, session-corpus, grounded backfill | The deep promotion loop alone captures the behavior |
| Skills | `clawhub`, install managers, 6-tier precedence, symlink hardening, snapshot cache | A folder scan + `requires.bins` + catalog injection is the whole contract |
| Tools | Descriptor/executor unions, availability expression tree, plugin-SDK indirection, MCP | Collapse to one `{name, parameters, execute}` registry |
| Subagents | ACP protocol (~1,500 lines), thread-bound persistent sessions, attachments, sandbox tiers | Native in-process spawn + depth cap is faithful and tiny |
| Channels | Multi-channel registry, gateway WS server + RPC + operator scopes, multi-account, watchdog | Lite has one channel and runs the socket in-process |
| Auth/state | Multi-provider rotation/cooldowns, secret-ref (`env/file/exec`), AES-GCM at-rest, keychain, doctor/migrations, `.clawdbot` legacy | One Codex profile in a `0600` file is enough |
| Config | ~930-line zod schema (TTS personas, media understanding, browser profiles, per-surface queues) | Essential config ≈ `{model}` + Codex auth |
| Docker/deploy | Bun toolchain, matrix native addon, canvas/UI/qa builds, Chromium/Playwright, 137 extensions, fly/render, `cli` service | Single-stage `node:24-slim` + one service + one volume |
| Native apps | `apps/{ios,android,macos}`, `appcast.xml`, Sparkle auto-update | Entirely out of scope for a Lite backend |

---

## 16. Key design decisions worth preserving (the "why")

- **"Skills own workflows; root owns hard policy"** (`AGENTS.md:4`). Keep policy in a root `AGENTS.md` bootstrap file; keep how-to knowledge in skills. This separation is why the prompt stays small and skills are pluggable.
- **"No hidden state; memory is files"** (`memory.md:9`). Inspectability *is* the feature. Never move core memory into an opaque DB.
- **Progressive disclosure of skills.** Only names+descriptions are always in the prompt; the body is read on demand. This is what lets a system scale to dozens of skills without bloating context.
- **Message delivery as a tool.** Lets the agent choose to send mid-turn and lets the runner detect "already replied" → suppress redundant text.
- **Promotion with provenance + idempotency markers.** Learning is auditable and re-runnable; `MEMORY.md` diffs cleanly.
- **Rehydrate-before-promote.** Never promote stale snippets — always re-read the live daily file. Keeps learned memory truthful.
- **Confirm before irreversible external actions** (send email / create event). A soft prompt rule operationalized as draft→confirm→send.
- **Deterministic ordering** of context sections and file lists — reproducibility and prompt-cache friendliness.

---

## 17. Open decisions carried into Phase 2

1. **Agent loop:** reuse Pi vs. hand-roll a Responses-API loop. → *Lean: hand-roll (~150 lines), since Codex-only + inspectability.*
2. **Google:** wrap `gog` CLI as a skill vs. Node `googleapis` tools. → *Lean: `gog`-as-skill for faithfulness; document the `googleapis` alternative.*
3. **Memory search backend:** substring vs. SQLite-FTS vs. embeddings. → *Lean: start with a simple lexical/`ripgrep`-style search behind the `memory_search` signature; upgradeable.*
4. **Context bounding:** transcript pruning vs. compaction. → *Lean: pruning (cheaper, dependency-free).*
5. **Language/runtime:** Node + TypeScript (matches the original, `baileys`, `googleapis`, easy Docker). → *Confirmed.*

---

### Appendix: naming & orientation
- Product **OpenClaw**; CLI `openclaw`; state `~/.openclaw`; config `openclaw.json`.
- Embedded engine: `@earendil-works/pi-coding-agent` ("Pi").
- WhatsApp lib: `baileys`. Google: `gog` CLI. Model auth: `openai-codex` OAuth.
- Root identity/policy doc: `AGENTS.md` (symlinked `CLAUDE.md`). Memory philosophy: `docs/concepts/memory.md`. Dreaming: `docs/concepts/dreaming.md`.
