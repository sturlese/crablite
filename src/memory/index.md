# src/memory — the workspace, search, and the self-learning loop

## Purpose

crablite's memory is Markdown on disk, nothing else. This directory owns the workspace files, the
daily notes, the two read tools the model uses, the recall signal, the pre-prune flush, and the
nightly "dreaming" promotion that turns often-recalled notes into long-term memory.

The loop, end to end:

```
long conversation → flush.ts   → memory/<today>.md
memory_search hit → recall.ts  → memory/.recall.json
nightly           → dreaming.ts → MEMORY.md (+ DREAMS.md diary)
```

## Key entry points

| File | Role |
| --- | --- |
| `workspace.ts` | `seedWorkspace()`, `loadProjectContext()`, `loadRecentDailyNotes()`, `appendDailyNote()`, `dailyNotePath()`, `listDailyNotes()`, `todayStamp()`, `BOOTSTRAP_FILES`. |
| `search.ts` | `MEMORY_TOOLS` = `memory_search` (lexical, ranked, records recall) + `memory_get` (exact excerpt). |
| `recall.ts` | `recordRecall()`, `allEntries()`, `markPromoted()`, `keyFor()`. The dreaming signal store. |
| `flush.ts` | `runMemoryFlush(model, items)` — silent turn that extracts durable bullets before context is dropped. |
| `dreaming.ts` | `runDreaming(model?)` — rank → gate → rehydrate → promote → compact → diary → mark. |

## Use these

- **`todayStamp()`** for every date stamp (`YYYY-MM-DD`, local). It is the key format for daily
  notes, recall days and promotion sections.
- **`appendDailyNote(text)`** to write to today's note; it creates the file with a header.
- **`paths.memoryDir()` / `paths.recallFile()`** rather than composing paths.
- **`resolveInside(paths.workspace(), …)`** before reading any path that came from a store.
  `.recall.json` is agent-writable, so `dreaming.ts` `rehydrate` contains it — do the same for any
  new consumer.
- **`BOOTSTRAP_FILES`** as the single list of workspace files and their prompt injection order.

## Avoid / anti-patterns

- Do **not** inject daily notes wholesale into the prompt. They are searched, not loaded;
  `loadRecentDailyNotes` is the one bounded exception (last ~2 days, char-capped).
- Do **not** have the agent edit `MEMORY.md` directly except to correct a mistake. It is curated by
  dreaming — the system prompt and `AGENTS.md` both say so; keep those aligned.
- Do **not** mark entries promoted before confirming the section survived `compactMemory`.
  `runDreaming` re-reads the markers precisely because a budget-full `MEMORY.md` can evict the
  section it just wrote; marking anyway would bar those entries forever.
- Do **not** inflate the recall signal. `memory_search` records each distinct snippet **at most
  once per search** (`recorded` set) — `recallCount` counts recall *events*, not matched blocks.
- Do **not** record recalls from `MEMORY.md`. Only daily-note hits (`isDaily`) feed promotion;
  otherwise already-promoted content would promote itself again.
- Do **not** let compaction touch user-written content. `compactMemory` only drops whole
  `## Promoted From Short-Term Memory` sections, oldest first.
- Do **not** make flush or dreaming fatal. Both are best-effort: they log and continue, because a
  model hiccup must never lose a user's turn.
- Do **not** add a database. Lexical search is dependency-free on purpose; the `memory_search`
  signature is shaped so embeddings could slot in later.

## Data & contracts

- **Workspace files** (`~/.crablite/workspace/`), seeded from `workspace-template/`:
  `AGENTS.md`(10) · `SOUL.md`(20) · `IDENTITY.md`(30) · `USER.md`(40) · `MEMORY.md`(70) are
  injected into `# Project Context` in that order, each capped at 12k chars.
  `DREAMS.md`(998) and `HEARTBEAT.md`(999) are seeded but never injected.
- **Daily notes**: `memory/YYYY-MM-DD.md` (a `-slug` suffix is also matched by the listing regex).
- **`RecallEntry`** (`recall.ts`) in `memory/.recall.json`:
  `{ key, snippet, source: "memory/<file>.md:<start>-<end>", recallCount, maxScore, queryHashes[],
  recallDays[], firstSeen, lastRecalled, promotedAt? }`.
- **Promotion ranking** (`dreaming.ts`): `0.30·relevance + 0.24·frequency + 0.15·diversity +
  0.15·recency + 0.16·consolidation`. Gates: `score ≥ 0.5`, `recallCount ≥ 3`,
  `uniqueQueries ≥ 2`, not already promoted. Budget: `MEMORY.md ≤ 10k chars`.
- **Idempotency marker**: `<!-- crablite-promotion:<key> -->` inside `MEMORY.md`.

## Tests

`test/workspace.test.ts`, `test/search.test.ts`, `test/recall.test.ts`, `test/flush.test.ts`,
`test/dreaming.test.ts`. They run against a real temp workspace (`test/helpers.ts` `tmpState()`)
with only the model call mocked — so file layout, ranking and compaction are covered for real.

## Common tasks

| Task | Where |
| --- | --- |
| Add a workspace bootstrap file | `BOOTSTRAP_FILES` in `workspace.ts` + a template in `workspace-template/` (+ `paths.ts` if it needs a named accessor) |
| Change injection order / budget | `workspace.ts` (`order`, `PER_FILE_BUDGET`) |
| Tune promotion aggressiveness | `dreaming.ts` (`W`, `MIN_SCORE`, `MIN_RECALL_COUNT`, `MIN_UNIQUE_QUERIES`) |
| Change long-term memory size | `dreaming.ts` `MEMORY_BUDGET_CHARS` |
| Improve search ranking | `search.ts` (`tokenize`, `score`, `collectBlocks`) |
| Change what a flush keeps | `flush.ts` `FLUSH_INSTRUCTIONS` |
| Change startup context | `workspace.ts` `loadRecentDailyNotes` defaults |

## Notes

- `dreaming.ts` **rehydrates from the live file** rather than trusting the stored snippet: if the
  user edited or deleted the note, the promotion is skipped. Memory follows the files, not a cache.
- Flush is throttled twice: only above `FLUSH_TRIGGER_CHARS` *and* only after
  `FLUSH_MIN_GROWTH_CHARS` of new transcript since the last flush (state in the session index).
- `runDreaming(model?)` works without a model — promotion is pure logic; the model only writes the
  reflective `DREAMS.md` line, with a fallback string.
- Stopwords in `search.ts` include Spanish-friendly characters in the tokenizer; the stopword list
  itself is English.
