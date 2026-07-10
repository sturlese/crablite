# crablite — Design (Phase 2)

> **crablite** = a much smaller, faithful distillation of OpenClaw. It keeps OpenClaw's *soul* — file-based inspectable memory, self-learning "dreaming", folder-based skills, autonomous subagents, WhatsApp-first with a dev CLI, Codex OAuth — and drops the platform machinery (multi-channel gateway, plugin SDK, vector DBs, ACP, native apps, key rotation, at-rest encryption).
>
> This document justifies every important decision and is the implementation blueprint for Phase 3. It builds directly on `docs/openclaw_research.md`.

---

## 1. Locked decisions (with rationale)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Name / identifiers | **crablite** — package & CLI `crablite`, state `~/.crablite`, Docker image `crablite` | User choice; keeps the crab/claw lineage. |
| D2 | Language / runtime | **Node 24 + TypeScript (ESM)**, pnpm | Matches OpenClaw; native `baileys`, `gog`, `fetch`; trivial Docker. |
| D3 | Agent loop | **Hand-rolled** ~200-line tool-calling loop against the **Codex Responses API** | OpenClaw delegates to the opaque `@earendil-works/pi-coding-agent`; we only target Codex, so a small inspectable loop is cleaner than an unavailable/heavy dependency. Keeps "few dependencies, easy to understand". |
| D4 | Model auth | **Codex OAuth only** (device-code + PKCE), tokens in `~/.crablite/auth/codex.json` (0600) | User requirement ("solo OAuth de Codex"). Ported ~verbatim from `extensions/openai/openai-codex-device-code.ts`. Provider layer is swappable but only Codex is built. |
| D5 | Model transport | OpenAI **Responses API** at `https://chatgpt.com/backend-api/codex/responses`, default model `gpt-5.5` | The confirmed OpenClaw Codex transport (`extensions/openai/base-url.ts:3`, `default-models.ts:7`). |
| D6 | Memory | **File-based, two-tier**, verbatim injection, no DB | The user's hard requirement and OpenClaw's essence ("no hidden state"). |
| D7 | Self-learning | **Dreaming**: nightly ranked promotion of daily notes → `MEMORY.md`, provenance + `DREAMS.md` | The behavior the user wants; needs only Markdown + one JSON recall file. |
| D8 | Skills | **Folder + `SKILL.md`**, progressive disclosure, `requires.bins` gating | The "add a skill by creating a folder" property. |
| D9 | Google (Gmail/Sheets) | **Wrap the `gog` CLI as a skill** | User choice; faithful to OpenClaw, ~zero code. Send requires **explicit confirmation** (draft → confirm → send). |
| D10 | Subagents | **`spawn_subagent` tool**, native in-process, isolated child, depth cap | Autonomous (not user-command-gated); drop ACP. |
| D11 | Channels | **One `Channel` interface**; WhatsApp (`baileys`, QR) + CLI REPL; no gateway daemon | Single account, in-process; the CLI is the same interface for dev/debug. |
| D12 | Context bounding | **Transcript pruning** (keep recent turns; never prune the first user msg) + **memory-flush** before pruning | Cheaper than LLM compaction; preserves the memory-flush idea that feeds dreaming. |
| D13 | Config | `~/.crablite/config.json` (`{ model, ... }`), env overrides, light hand validation (no zod) | OpenClaw's 930-line schema is 99% accessory. |
| D14 | Search backend | **Lexical** (substring + token scoring) behind `memory_search` | Embeddings would need a second provider/API key, contradicting "Codex only". Signature is upgrade-ready. |

---

## 2. Architecture & module layout

Small, flat, one concern per file. Target: a developer can read the whole `src/` in an afternoon.

```
crablite/
  package.json  tsconfig.json  .env.example  .gitignore  .dockerignore
  Dockerfile  docker-compose.yml
  README.md
  docs/  openclaw_research.md  lite_design.md  architecture.md  deployment.md
  workspace-template/          # seeded into ~/.crablite/workspace on first run
    AGENTS.md  SOUL.md  IDENTITY.md  USER.md  MEMORY.md  DREAMS.md
  skills/                      # bundled skills (shipped in the image)
    gog/SKILL.md               # Google Workspace (Gmail/Sheets) via gog CLI
    weather/SKILL.md           # tiny example (curl wttr.in)
    web-search/SKILL.md        # example using web_fetch
  src/
    index.ts                   # CLI entry: crablite <login|chat|whatsapp|dream|doctor>
    config.ts                  # state dir + config.json resolution, env precedence
    logger.ts                  # tiny leveled logger
    paths.ts                   # ~/.crablite path helpers
    codex/
      auth.ts                  # device-code login + refresh + getAccessToken()
      responses.ts             # Responses API client (streaming SSE, tool calls)
    agent/
      loop.ts                  # runTurn(): the model↔tool loop; NO_REPLY handling
      system-prompt.ts         # buildSystemPrompt(): ordered sections
      tools.ts                 # tool registry + core tools (read/write/edit/exec/message/web_fetch)
      subagent.ts              # spawn_subagent tool + subagent system prompt
      prune.ts                 # transcript pruning
    memory/
      workspace.ts             # load/seed bootstrap files (SOUL/IDENTITY/USER/MEMORY…)
      search.ts                # memory_search + memory_get tools (lexical)
      recall.ts                # recall.json tracking (short-term recall signals)
      dreaming.ts              # rank + promote daily notes → MEMORY.md; write DREAMS.md
      flush.ts                 # pre-prune memory-flush turn
    skills/
      loader.ts                # scan dirs → parse SKILL.md → catalog + gating
    session/
      store.ts                 # sessions.json map + JSONL transcript append/reload
    channels/
      types.ts                 # Channel + InboundMessage
      whatsapp.ts              # baileys adapter (QR login, messages.upsert)
      cli.ts                   # readline REPL adapter (same interface)
    handle.ts                  # handleInbound(): admission → runTurn → reply; debounce
    dreaming-cron.ts           # nightly scheduler (setInterval-based)
```

**Dependencies (deliberately few):** `baileys` (WhatsApp), `qrcode-terminal` (render QR), `pino` (baileys' logger). Model calls use global `fetch` + manual SSE — **no model SDK**. Gmail/Sheets use the external `gog` binary (not an npm dep). Dev: `typescript`, `tsx`, `@types/node`.

---

## 3. On-disk state (`~/.crablite`)

Mirrors OpenClaw's philosophy, collapsed to one agent:

```
~/.crablite/
  config.json                 # { "model": "gpt-5.5", "allowFrom": ["*"], "dreaming": true, ... }
  auth/
    codex.json                # { version, access, refresh, expires, accountId, email, planType }  (0600)
  workspace/                  # THE MEMORY — all Markdown, user-inspectable/editable
    AGENTS.md                 # hard policy & routing (order 10)
    SOUL.md                   # persona & tone (order 20)
    IDENTITY.md               # structured self: name, emoji, vibe (order 30)
    USER.md                   # durable facts about the human (order 40)
    MEMORY.md                 # long-term memory, injected verbatim (order 70)
    DREAMS.md                 # dreaming diary (not injected)
    memory/
      YYYY-MM-DD.md           # daily/working notes (searchable, not injected wholesale)
      .recall.json            # recall tracking (short-term signals)  [machine state]
    skills/                   # user-dropped skills (highest precedence)
  sessions/
    sessions.json             # { sessionKey: { sessionId, file, updatedAt } }
    <sessionId>.jsonl         # append-only transcript (one line per message)
  logs/                       # optional run logs
```

Env overrides: `CRABLITE_STATE_DIR`, `CRABLITE_CONFIG_PATH`, `CRABLITE_MODEL`, `CRABLITE_ALLOW_FROM`. Dirs `0700`, secret files `0600`.

---

## 4. The agent loop (`agent/loop.ts` + `codex/responses.ts`)

`runTurn({ sessionKey, userText, channel, onChunk })`:
1. Resolve session (`session/store.ts`): `sessionKey → { sessionId, file }`; reload transcript items (JSONL) into Responses `input` items.
2. Build the system prompt (`buildSystemPrompt`, §6) → Responses `instructions`.
3. Assemble tool schemas from the registry (`tools.ts`) + `spawn_subagent` + memory + skills' implicit tools (skills use `exec`, so no extra schema).
4. **Loop:** POST to `/responses` with `{ model, instructions, input, tools, stream:true }`; parse SSE:
   - `response.output_text.delta` → accumulate assistant text; forward blocks to `onChunk` (chunked on paragraph/sentence).
   - `response.output_item.done` of type `function_call` → collect `{name, arguments, call_id}`.
   - `response.completed` → if there were tool calls, execute each (`registry.execute(name, args)`), append `function_call` + `function_call_output` to `input`, and **loop again**; else stop.
5. Persist new items to the JSONL transcript; update `sessions.json`.
6. If final assistant text is exactly `NO_REPLY` → return silent (no delivery).
7. **Backstops:** an `AbortController` idle-timeout (~120s with no SSE token) and a max-iteration cap (default 12 tool rounds). One retry on transient network/5xx.

**Confirm-before-send** is enforced at the loop/policy level for irreversible external actions: the `message` tool and the `gog gmail send`/`gog gmail drafts send` path are governed by the system prompt rule "draft → ask → send only after an explicit user 'yes'". (We keep it a strong prompt rule — matching OpenClaw — and additionally make the *default* gog usage create drafts.)

---

## 5. Codex auth & transport (`codex/auth.ts`, `codex/responses.ts`)

Ported from `extensions/openai/openai-codex-device-code.ts` + `openai-codex-auth-identity.ts`:
- **Constants:** auth base `https://auth.openai.com`, client id `app_EMoamEEZ73f0CkXaXp7hrann`, device verify `…/codex/device`, callback `…/deviceauth/callback`, transport base `https://chatgpt.com/backend-api/codex`.
- **login()** (`crablite login`): POST `/api/accounts/deviceauth/usercode` → show URL + `user_code` → poll `/api/accounts/deviceauth/token` (403/404 = keep polling, 15-min deadline) → exchange `/oauth/token` (`grant_type=authorization_code`, `code_verifier`) → `{access, refresh, expires}`.
- **identity()**: base64url-decode the access-token JWT → `accountId` (`https://api.openai.com/auth.chatgpt_account_id`), `email`, `planType`, `exp`.
- **getAccessToken()**: if `expires - now ≤ 5·60·1000` → refresh via `/oauth/token` (`grant_type=refresh_token`, `client_id`, `refresh_token`), rewrite `codex.json`; else return stored `access`.
- **Request headers:** `Authorization: Bearer <access>`, `ChatGPT-Account-Id: <accountId>`, `originator: crablite`, `User-Agent: crablite/<ver>`, `Content-Type: application/json`, `OpenAI-Beta: responses=experimental`, `session_id: <uuid>`. (The last two match the ChatGPT-backend Codex convention; isolated so they're easy to adjust — see `docs/deployment.md` "Codex transport" troubleshooting.)

> **Integration risk (documented):** the ChatGPT-backend `/responses` request/header contract is implemented inside the non-vendored `pi-ai` in OpenClaw. crablite implements the best-known public contract; if OpenAI changes it, only `codex/responses.ts` needs a tweak. Everything is surfaced with clear error messages.

---

## 6. Context & system prompt (`agent/system-prompt.ts`)

One synchronous function, ordered sections (faithful to `system-prompt.ts` but collapsed):
1. Identity line: "You are {name}, a personal assistant running in crablite."
2. `## Tools` — `- name: summary` for each registered tool.
3. `## Policy` — inline Safety + Execution Bias + the **confirm-before-send** rule + `NO_REPLY` guidance.
4. `## Skills` — the `<available_skills>` catalog (name/description/location) + "read the SKILL.md at <location> and follow it".
5. `## Memory` — guidance: use `memory_search`/`memory_get` before answering about prior work; write durable facts to `memory/YYYY-MM-DD.md`.
6. `## Workspace` — working dir path.
7. `# Project Context` — the bootstrap files' **contents**, ordered AGENTS(10)→SOUL(20)→IDENTITY(30)→USER(40)→MEMORY(70), each `## <name>` + body, per-file budget ~12k chars.
8. `## Runtime` — one line: date, os, model, channel.

Bootstrap files loaded by `memory/workspace.ts`; missing ones skipped; first run seeds them from `workspace-template/`.

---

## 7. Memory & dreaming (`memory/*`)

**Read tools:** `memory_search(query, {maxResults})` — lexical scan of `MEMORY.md` + `memory/*.md`, token-overlap scored, returns `{path, lines, excerpt, score, source}`; on a hit from a daily file, record a recall signal. `memory_get(path, {start,end})` — bounded excerpt.

**Recall tracking (`recall.json`):** per short-term snippet key → `{ recallCount, maxScore, queryHashes[], recallDays[], firstSeen, lastRecalled, promotedAt? }`. Only daily-file hits count (never `MEMORY.md`).

**Dreaming (`dreaming.ts`, nightly via `dreaming-cron.ts`, and `crablite dream` manual):**
1. Rank recall entries: `score = 0.30·relevance + 0.24·frequency + 0.15·diversity + 0.15·recency(14d half-life) + 0.16·consolidation(multi-day)`.
2. Gate: `minScore 0.7`, `minRecallCount 3`, `minUniqueQueries 2`, not already promoted.
3. **Rehydrate** each snippet from its live daily file (drop if gone/edited).
4. Append to `MEMORY.md` under `## Promoted From Short-Term Memory (DATE)`, each bullet prefixed with `<!-- crablite-promotion:<key> -->` and `[score= recalls= source=path:lines]`.
5. Budget-compact `MEMORY.md` (drop oldest promotion sections over ~10k chars; never touch user content).
6. Append a first-person entry to `DREAMS.md`; mark `promotedAt` in `recall.json`.

**Memory-flush (`flush.ts`):** before transcript pruning, run one silent agent turn instructed to append durable facts to today's `memory/YYYY-MM-DD.md` (treating `MEMORY.md`/`SOUL.md` as read-only). This is what makes the loop learn.

---

## 8. Skills (`skills/loader.ts`)

`loadSkills(dirs)` scans (low→high precedence) `<bundled>/skills`, `<workspace>/skills`: for each `*/SKILL.md`, parse YAML frontmatter; require `name` + `description`; read `metadata.crablite.requires.bins` and **skip** the skill if any bin is absent from `PATH` (`which`). Dedup by name (higher wins). `formatCatalog()` → `<available_skills>` with `<name>/<description>/<location>`. Activation = the model reads the file via the `read` tool. (We accept OpenClaw's `metadata.openclaw` block too, for drop-in compatibility of skills like `gog`.)

Frontmatter accepted:
```yaml
name: gog
description: Google Workspace CLI for Gmail, Calendar, Drive, Sheets, Docs.
metadata: { crablite: { requires: { bins: ["gog"] } } }   # openclaw block also honored
```

---

## 9. Tools & subagents (`agent/tools.ts`, `agent/subagent.ts`)

**Registry:** `Map<name, { name, description, parameters /*JSON schema*/, execute(args, ctx) }>`. Core tools:
- `read(path[, start,end])`, `write(path, content)`, `edit(path, old, new)` — workspace-scoped file ops.
- `exec(command[, cwd, timeoutSec])` — shell; how skills (incl. `gog`) act. Bounded output.
- `message(text)` — deliver a message to the current chat (channel send); lets the agent reply mid-turn.
- `memory_search`, `memory_get` — §7.
- `web_fetch(url)` — fetch a URL to text (for the web-search example skill). *(optional)*
- `spawn_subagent(task[, label, timeoutSec])` — §below.

**`spawn_subagent`:** checks a **depth cap** (default 2); builds a subagent system prompt ("You are a subagent. Complete the task in the first [Subagent Task] message. Your final message is returned to the parent. Stay focused; don't ask the user."); runs the **same `runTurn`** with an isolated session (no channel delivery), the same tools **minus `spawn_subagent` at max depth**; returns the child's final assistant text to the parent as the tool result. Synchronous (no background/parallel in Lite).

---

## 10. Channels & the shared seam (`channels/*`, `handle.ts`)

```ts
interface InboundMessage { chatId; senderId; chatType:"direct"|"group"; text; reply(text): Promise<{messageId}>; }
interface Channel { id; start(onInbound): Promise<void>; stop(): Promise<void>; }
```
- **WhatsApp (`whatsapp.ts`):** `baileys` + `useMultiFileAuthState(~/.crablite/auth/whatsapp)`; QR to terminal/logs via `qrcode-terminal`; `messages.upsert` (type `notify`, skip `fromMe`) → normalize → `onInbound`; `reply` = `sock.sendMessage(jid, {text})`; reconnect unless `loggedOut`.
- **CLI (`cli.ts`):** `readline`; each line → `InboundMessage` whose `reply()` prints to stdout. `--once "<msg>"` for scripted debug. Same interface ⇒ same agent path.

**`handleInbound(msg)`** (both channels call it): (1) allowlist (`config.allowFrom`, `*` = all; match `senderId`); (2) dedupe by message id; (3) per-chat **debounce** (coalesce rapid messages, default 0ms, configurable); (4) `runTurn({ sessionKey: keyFor(msg), userText, onChunk: deliver })`; (5) deliver final reply unless `NO_REPLY`. `sessionKey = crablite:<channel>:<chatType>:<chatId>`.

---

## 11. Docker (`Dockerfile`, `docker-compose.yml`)

Single-stage, bakes `gog`:
```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git tini \
 && update-ca-certificates && rm -rf /var/lib/apt/lists/*
# Gmail/Sheets CLI (choose arch asset via build-arg)
ARG GOG_ARCH=linux_amd64
RUN curl -fsSL https://github.com/steipete/gogcli/releases/latest/download/gogcli_${GOG_ARCH}.tar.gz \
 | tar -xzO gog > /usr/local/bin/gog && chmod +x /usr/local/bin/gog || true
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile || pnpm install
COPY . .
RUN pnpm build
ENV CRABLITE_STATE_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["tini","-s","--"]
CMD ["node","dist/index.js","whatsapp"]
```
`docker-compose.yml`: one service, `env_file: .env` (optional), volume `./data:/data` (or a named volume), `stdin_open+tty` (so the QR + `crablite login` device code are visible), `restart: unless-stopped`. First-run flow documented in `deployment.md`: `docker compose run --rm crablite login` (Codex), scan WhatsApp QR from `docker compose up` logs, `docker compose exec crablite gog auth ...` for Google.

---

## 12. What is kept / simplified / dropped (vs OpenClaw)

**Kept faithfully:** file-based memory (SOUL/IDENTITY/USER/MEMORY + daily), dreaming promotion with provenance + DREAMS.md, folder skills with progressive disclosure + `requires.bins`, `memory_search`/`memory_get` two-tool read contract, autonomous `spawn_subagent`, ordered `# Project Context`, `NO_REPLY` silent policy, mention/allowlist admission, WhatsApp via baileys (QR), CLI dev REPL, Codex OAuth (device-code) + refresh + account-id header, gog-as-skill for Google, Docker-first, memory-flush before context trim.

**Simplified:** one hand-rolled loop instead of the Pi engine + 2000-line resilience loop; one lexical search instead of vector/LanceDB/QMD; one Codex profile in a 0600 file instead of encrypted multi-profile rotation; a flat config instead of a 930-line zod schema; native in-process subagents instead of ACP; transcript pruning instead of LLM compaction; single account/in-process instead of a gateway daemon + WS RPC.

**Dropped:** context-engine registry, plugin SDK, MCP, memory-wiki/active-memory/multimodal, light/REM dream phases, install managers/clawhub, multi-channel registry + all non-WhatsApp channels, native iOS/Android/macOS apps + Sparkle, fly/render deploy, key rotation/cooldowns, secret-ref indirection, doctor/migrations, TTS/voice/media/image generation, browser automation.

---

## 13. Feature checklist (maps to the user's brief)

- [ ] Main conversational agent (loop + streaming) — §4
- [ ] WhatsApp primary interface (baileys, QR) — §10
- [ ] CLI for dev/debug (`crablite chat`) — §10
- [ ] Pluggable skills by folder (`SKILL.md`) — §8
- [ ] File-based memory: soul, identity, user, working (daily), long-term — §7
- [ ] Agent knows when to read/write/summarize/update/compact memory — prompt + flush + dreaming
- [ ] Self-learning (dreaming promotion, evolving MEMORY.md) — §7
- [ ] Autonomous subagents (`spawn_subagent`) — §9
- [ ] Google: Gmail (search/read/summarize/draft/**send after confirm**) + Sheets (read/write/update) via gog — §8/§9
- [ ] Codex OAuth only — §5
- [ ] Everything runs via `docker compose up` — §11
- [ ] Docs: README, architecture, examples, example skills, memory examples, deployment, checklist — Phase 4

---

## 14. Build order (Phase 3)

1. Scaffold: `package.json`, `tsconfig.json`, `.gitignore`, `paths.ts`, `config.ts`, `logger.ts`.
2. Codex: `codex/auth.ts`, `codex/responses.ts` → `crablite login` works end-to-end.
3. Agent core: `agent/tools.ts`, `agent/system-prompt.ts`, `agent/loop.ts`, `session/store.ts` → `crablite chat` works.
4. Memory: `memory/workspace.ts`, `memory/search.ts`, `memory/recall.ts`, `memory/flush.ts`, `agent/prune.ts`.
5. Skills: `skills/loader.ts` + bundled `skills/{gog,weather,web-search}` + `workspace-template/*`.
6. Subagents: `agent/subagent.ts`.
7. Dreaming: `memory/dreaming.ts`, `dreaming-cron.ts` + `crablite dream`.
8. Channels: `channels/types.ts`, `channels/cli.ts`, `channels/whatsapp.ts`, `handle.ts`, wire `index.ts`.
9. Docker: `Dockerfile`, `docker-compose.yml`, `.env.example`, `.dockerignore`.
10. Phase 4 docs.
