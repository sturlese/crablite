# src/agent — turn orchestration, tools, scheduling

## Purpose

Everything between "we have a user message" and "we have a reply": session loading, prompt
assembly, the model↔tool loop, the tool catalog itself, subagent delegation, and the stores/tools
for scheduled work (reminders and routines).

## Key entry points

| File | Role |
| --- | --- |
| `runner.ts` | **`runTurn(params)`** — the high-level entry both channels and the heartbeat call. Slash commands → session (cached) → schedule memory flush → user item (STT/vision/documents) → prune → tools + prompt → loop → persist. Returns `{ replyText, silent }`. When over `FLUSH_TRIGGER_CHARS` and a `chatId` exists, the flush is **deferred**: input snapshot-copied and `setFlushedChars` recorded at scheduling time, then queued (not awaited) via `withLock(chatId, …)` so it runs after this reply. The CLI path (no `chatId`) keeps the inline awaited flush. |
| `loop.ts` | **`runAgentLoop(params)`** — the primitive: call model, execute tool calls, feed outputs back, repeat until no tool calls or `maxRounds`. Returns final text + all new transcript items. |
| `tool.ts` | The **`Tool` / `ToolContext` contract**. Depend on this, not on `tools.ts`, when you only need the type. |
| `tools.ts` | `CORE_TOOLS`: `read`, `write`, `edit`, `exec`, `message`, `send_file`, `react`, `web_fetch`. |
| `system-prompt.ts` | `buildSystemPrompt(params)` — ordered sections: identity → tools → policy → skills → memory → recent activity → workspace → `# Project Context` → runtime. |
| `subagent.ts` | `makeSpawnTool(opts)` → the `spawn_subagent` tool; `buildSubagentPrompt`. |
| `prune.ts` | `pruneForContext`, `estimateChars`, `FLUSH_TRIGGER_CHARS`, `FLUSH_MIN_GROWTH_CHARS`. |
| `reminders.ts` | One-shot commitment store + the `schedule_reminder` tool. **At-least-once delivery protocol**: `claimReminder(id, now)` (phase 1: persist `deliveringAt`, count the attempt, BEFORE sending) and `markDelivered(id)` (phase 2: confirm, ONLY after a successful send). `dueReminders(now)` is the **single operational filter** — undelivered + due + (unclaimed or claim ≥ `CLAIM_STALE_MS` old) + attempts < `MAX_DELIVERY_ATTEMPTS` + not abandoned. `sweepAbandoned(now)` idempotently stamps crash-exhausted reminders (`abandonedAt`, terminal) and returns only the newly stamped. |
| `routines.ts` | Recurring routine store + schedule maths (`computeNextRun`, `parseAt`, `describeSchedule`). No tools here. |
| `schedule-tools.ts` | `SCHEDULE_TOOLS`: `schedule_routine`, `list_schedules`, `cancel_schedule`. |

## Use these

- **`Tool` from `tool.ts`** for any new model-facing capability. A tool is a plain object with a
  JSON-Schema `parameters` and an async `execute(args, ctx)`. Register it in the array built inside
  `runTurn`.
- **`ToolContext`** for chat-facing effects: `ctx.chatReply`, `ctx.chatSendFile`, `ctx.chatReact`.
  Always check for presence — subagents and the CLI do not have all of them.
- **`resolveInside(ctx.workspaceDir, p)`** (from `../paths.js`) in every tool that takes a path.
- **`runAgentLoop`** when you need an isolated agent run (this is exactly what `subagent.ts` does).
  Do not re-implement the loop.
- **Return strings, never throw, from `execute`.** The loop catches and stringifies, but a
  `"ERROR: …"` return is what the model can actually recover from.
- **Flat tool parameters** (see `schedule-tools.ts`): spell out every field rather than nesting
  unions. Models get this right far more often.

## Avoid / anti-patterns

- Do **not** append the new user item to the session *before* building the model input.
  `pruneForContext` returns `session.items` itself when under budget and `appendItems` mutates in
  place, so the turn would be sent twice. `runner.ts` documents this ordering — preserve it.
- Do **not** hand `session.items` (or a `pruneForContext` result) to deferred work without a
  snapshot copy. `loadSession` returns a shared, cached, mutable object; the deferred flush copies
  its input at scheduling time for exactly this reason.
- Do **not** await the deferred flush on the reply path, and do not move `setFlushedChars` to
  completion time — recording at scheduling time is what prevents a second over-threshold turn
  from queueing a duplicate flush while the first is pending. Ordering guarantee is
  **FIFO-from-scheduling**: a turn already queued on the chat lock before the flush was scheduled
  may run first (harmless — the input was snapshotted and the throttle already recorded).
- Do **not** give subagents chat-facing tools. `subagent.ts` filters out `message`, `send_file` and
  `react` on purpose: there is no user on the other end of a child run.
- Do **not** use `Math.max(1, Number(x))` for model-supplied numbers without a `Number.isFinite`
  guard — `NaN` propagates and silently breaks timeouts and due-dates (both `tools.ts` `exec` and
  `reminders.ts` carry a comment about exactly this bug).
- Do **not** put prompt policy in more than one place. Hard rules live in `system-prompt.ts` and in
  `workspace-template/AGENTS.md` (user-editable); workflow detail belongs in a skill.
- Do **not** replay missed routine occurrences. `advanceRoutine` is called *before* the run and
  recomputes from "now" — a crash skips forward, it never double-fires. This is the deliberate
  contrast with reminders: routines are at-most-once per occurrence (they recur anyway), reminders
  are at-least-once (a lost promise is worse than a rare duplicate).
- Do **not** select reminders for delivery any way other than `dueReminders()`. It is the single
  operational filter; a second query path would bypass the claim/attempt/abandonment gates.
- Do **not** call `markDelivered` before a send has actually succeeded, and do not skip
  `claimReminder` before attempting one — the claim-first/confirm-after ordering *is* the
  at-least-once guarantee.
- Do **not** introduce `await` inside the store functions of `reminders.ts` or `routines.ts`. The
  synchronous load → mutate → save shape is **load-bearing**: it is what makes heartbeat ticks and
  tool calls interleaving-safe on the JSON files (commented at the top of the store section in
  `reminders.ts`).
- Do **not** add a new store file without a `writeJsonFileAtomic` write and a `version` field.

## Data & contracts

- `Tool`, `ToolContext` (`tool.ts`).
- `TurnResult = { replyText, silent }` (`runner.ts`); `silent` is true for `""` or `NO_REPLY`.
- `LoopResult = { text, newItems }` (`loop.ts`).
- `Reminder` (`reminders.ts`) → `~/.crablite/reminders.json`, `{ version: 1, reminders: [] }`.
  At-least-once fields are **optional and additive** (`deliveringAt?`, `attempts?`, `abandonedAt?`)
  so the store stays version 1 and pre-existing files load unchanged. `abandonedAt` is terminal:
  never due again, still listed by `pendingReminders` and annotated
  "⚠️ delivery failed, will not retry" by `list_schedules` (rendered text only — the tool schema is
  untouched), still cancellable by id. Constants: `CLAIM_STALE_MS = 15 min` (post-crash retry
  latency — within one process the heartbeat's `running` guard prevents double-pickup, not this
  window), `MAX_DELIVERY_ATTEMPTS = 3`.
- `Routine`, `RoutineSchedule` (`routines.ts`) → `~/.crablite/routines.json`,
  `{ version: 1, routines: [] }`. Schedules are `daily{at}` | `weekly{weekday,at}` |
  `every{minutes}`, local wall-clock, `MIN_EVERY_MINUTES = 5`.
- Slash commands handled in `runner.ts`: `/reset`, `/dream`, `/help`.

## Tests

`test/runner.test.ts` (including a dedicated "memory flush scheduling" describe: deferred flush
off the reply path, serialization on the chat lock, CLI inline path, non-fatal failure),
`test/loop.test.ts`, `test/tools.test.ts`, `test/prune.test.ts`, `test/system-prompt.test.ts`,
`test/subagent.test.ts`, `test/reminders.test.ts` (including an "at-least-once claims" describe:
claim/confirm phases, the `dueReminders` gates, idempotent abandonment sweep),
`test/routines.test.ts`, `test/schedule-tools.test.ts` (including the abandoned-reminder
annotation in `list_schedules`). Only the network (model transport) is mocked; the filesystem runs
against a temp state dir from `test/helpers.ts`. The delivery side of the protocol is tested in
`test/heartbeat.test.ts` (see `test/index.md`).

## Common tasks

| Task | Where |
| --- | --- |
| Add a tool | New `Tool` in `tools.ts` (or its own module), then add it to the array in `runner.ts` |
| Expose a tool to subagents too | `subagent.ts` `childTools` (and keep it out of `CHAT_ONLY`) |
| Change prompt policy | `system-prompt.ts` section 3 |
| Change the context budget | `prune.ts` constants |
| Change flush timing | `prune.ts` `FLUSH_TRIGGER_CHARS` / `FLUSH_MIN_GROWTH_CHARS`, used in `runner.ts` |
| Add a schedule kind | `routines.ts` (`RoutineSchedule`, `computeNextRun`, `describeSchedule`) + `schedule-tools.ts` validation |
| Add a slash command | `runner.ts` `handleSlashCommand` (and mention it in `/help`) |

## Notes

- `runner.ts` builds the live user item with image parts but persists a text-only placeholder, so
  transcripts stay small. Keep that split if you add a new media kind.
- `system-prompt.ts` `firstSentence` deliberately skips abbreviations (`e.g.`, `i.e.`) when
  truncating tool descriptions — write descriptions with that in mind.
- `parallel_tool_calls` is `false` in the transport, so the loop can execute tool calls
  sequentially without extra bookkeeping.
