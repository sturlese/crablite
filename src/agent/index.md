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
| `reminders.ts` | One-shot commitment store + the `schedule_reminder` tool. |
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
  recomputes from "now" — a crash skips forward, it never double-fires.
- Do **not** add a new store file without a `writeJsonFileAtomic` write and a `version` field.

## Data & contracts

- `Tool`, `ToolContext` (`tool.ts`).
- `TurnResult = { replyText, silent }` (`runner.ts`); `silent` is true for `""` or `NO_REPLY`.
- `LoopResult = { text, newItems }` (`loop.ts`).
- `Reminder` (`reminders.ts`) → `~/.crablite/reminders.json`, `{ version: 1, reminders: [] }`.
- `Routine`, `RoutineSchedule` (`routines.ts`) → `~/.crablite/routines.json`,
  `{ version: 1, routines: [] }`. Schedules are `daily{at}` | `weekly{weekday,at}` |
  `every{minutes}`, local wall-clock, `MIN_EVERY_MINUTES = 5`.
- Slash commands handled in `runner.ts`: `/reset`, `/dream`, `/help`.

## Tests

`test/runner.test.ts` (including a dedicated "memory flush scheduling" describe: deferred flush
off the reply path, serialization on the chat lock, CLI inline path, non-fatal failure),
`test/loop.test.ts`, `test/tools.test.ts`, `test/prune.test.ts`, `test/system-prompt.test.ts`,
`test/subagent.test.ts`, `test/reminders.test.ts`, `test/routines.test.ts`,
`test/schedule-tools.test.ts`. Only the network (model transport) is mocked; the filesystem runs
against a temp state dir from `test/helpers.ts`.

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
