# docs — long-form documentation

## Purpose

The two documents that do not fit in the README: the code map and the deployment runbook. Together
with the per-directory `index.md` files they form the system map.

## Key entry points

| File | Audience / content |
| --- | --- |
| `architecture.md` | Code map: big-picture diagram, per-file module table, request lifecycle, the dreaming loop, sessions/persistence, auth & transport, the crablite↔OpenClaw mapping table, and the security posture. |
| `deployment.md` | Runbook: Docker and local install, Codex login, WhatsApp linking, Google/`gog` setup, operating commands, backup/restore, troubleshooting. |

## Documentation layout (where things belong)

| Question | Document |
| --- | --- |
| What is this, what can it do, how do I start? | `/README.md` |
| I am about to change the code — where do I start? | `/CONTRIBUTING.md` |
| How does a message flow through the code? | `docs/architecture.md` |
| How do I run and operate it? | `docs/deployment.md` |
| What lives in this directory, what do I reuse, what must I not do? | that directory's `index.md` |
| Why is this line like this? | the module header comment in the source file |

## Use these

- **Link, don't duplicate.** When a detail exists in a per-directory `index.md`, reference the path
  from here instead of restating it.
- **Cite real paths** (`src/agent/runner.ts`, `~/.crablite/sessions/`) so an agent can jump
  straight there.
- **Keep the OpenClaw mapping table** in `architecture.md` current — it is the fastest way for a
  newcomer to understand *why* something is small.

## Avoid / anti-patterns

- Do **not** paste code blocks from `src/` into these files. They go stale silently; reference the
  file and the function name.
- Do **not** restate config defaults in three places. The README table is the canonical one; other
  documents should link to it.
- Do **not** put operational secrets, real chat ids or phone numbers in examples.
- Do **not** claim behaviour you have not confirmed in the code. Documentation that lies is worse
  than none.
- Do **not** hardcode counts that drift (test totals, coverage percentages, line counts) without
  expecting to maintain them.

## Data & contracts

Numbers stated in these docs that must be re-checked when the code changes: the promotion ranking
weights and gates (`src/memory/dreaming.ts`), the context/flush budgets (`src/agent/prune.ts`), the
20 MB file cap (`src/media/files.ts`), config defaults (`src/config.ts`), coverage thresholds
(`vitest.config.ts`), the shutdown pair — 25s internal drain (`SHUTDOWN_DRAIN_MS`,
`src/index.ts`) under 30s `stop_grace_period` (`docker-compose.yml`) — and the reminder delivery
constants — 15 min stale-claim window (`CLAIM_STALE_MS`) and 3 attempts
(`MAX_DELIVERY_ATTEMPTS`), both in `src/agent/reminders.ts`.

## Tests

None — prose. Verification is reading the referenced code. `.github/workflows/ci.yml` does not lint
Markdown.

## Common tasks

| Task | Where |
| --- | --- |
| Added a module | `architecture.md` module table + the directory's `index.md` |
| Added a tool | `architecture.md` (prompt-inputs diagram + module table) + `src/agent/index.md` |
| Changed the state layout | `README.md` §4, `architecture.md`, `src/index.md`, `src/paths.ts` header |
| Changed deployment | `deployment.md` (+ `Dockerfile` / `docker-compose.yml` / `.env.example`) |
| Changed a config default | `src/config.ts`, then the README table |

## Notes

- `architecture.md` cites OpenClaw file paths as provenance. They are references to the upstream
  project, not paths in this repository — keep them at file granularity, since line numbers in
  another repo rot silently.
- Deployment artifacts referenced by `deployment.md` live at the repo root: `Dockerfile`,
  `docker-compose.yml`, `.env.example`.
