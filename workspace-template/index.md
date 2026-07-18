# workspace-template — the seed workspace

## Purpose

The files copied into `~/.crablite/workspace/` on first run (`seedWorkspace()` in
`src/memory/workspace.ts`). They are the agent's starting persona, policy and memory — and they are
meant to be edited by the user afterwards, by hand, in Markdown.

**Copied only when missing.** Editing a file here never changes an existing installation; it only
affects fresh workspaces.

## Key entry points

| File | Prompt order | Injected? | What it is |
| --- | --- | --- | --- |
| `AGENTS.md` | 10 | yes | Operating policy and routing. Telegraph style, hard rules. |
| `SOUL.md` | 20 | yes | Persona and tone, first person. |
| `IDENTITY.md` | 30 | yes | Structured self: name, emoji, vibe, pronouns, purpose. |
| `USER.md` | 40 | yes | Durable facts about the user. |
| `MEMORY.md` | 70 | yes | Long-term memory. Curated automatically by dreaming. |
| `DREAMS.md` | 998 | **no** | The self-learning diary (written by dreaming, read by humans). |
| `HEARTBEAT.md` | 999 | **no** | Guidance for the optional proactive daily check-in. |

Injected files are concatenated into the `# Project Context` section of the system prompt, in the
order above, each capped at 12k chars.

## Use these

- **`AGENTS.md` for hard rules and routing**; `SOUL.md` for voice. Keep the split — it mirrors
  OpenClaw's *"skills own workflows; root owns hard policy and routing."*
- **`IDENTITY.md` as structured key/value lines** — it is the machine-readable half of the persona.
- **`HEARTBEAT.md` to tune proactivity.** Its default guidance is "silence is usually the right
  answer"; it is only read when `CRABLITE_PRIMARY_CHAT` is set.
- **`BOOTSTRAP_FILES`** in `src/memory/workspace.ts` is the source of truth for this list, the
  order, and the inject flag. Add a file there and here together.

## Avoid / anti-patterns

- Do **not** contradict `src/agent/system-prompt.ts`. The policy section and `AGENTS.md` state the
  same rules (memory-search-first, confirm before sending, `NO_REPLY`, don't hand-edit `MEMORY.md`).
  If you change one, change the other — divergent policy is worse than no policy.
- Do **not** put user-specific content here. This is a template shipped in the package;
  personal facts belong in the *installed* `USER.md`.
- Do **not** seed a large `MEMORY.md`. It has a ~10k char budget and is auto-compacted; filling it
  with template text starves promotions (`runDreaming` will report it cannot store them).
- Do **not** add secrets, phone numbers or tokens. These files go straight into the model context.
- Do **not** expect edits here to reach an existing install — copy the file into the live workspace
  instead.

## Data & contracts

- Destination: `~/.crablite/workspace/` (`CRABLITE_STATE_DIR` aware).
- If a template file is absent, `seedWorkspace()` creates `MEMORY.md` / `DREAMS.md` with a bare
  heading; other missing files are simply skipped.
- The live workspace also grows `memory/` (daily notes + `.recall.json`), `inbox/` (received
  documents) and `skills/` (user skills) — none of which are seeded from here.

## Tests

`test/workspace.test.ts` — seeding into a temp state dir, idempotency (existing files are never
overwritten), injection order and per-file budgeting via `loadProjectContext()`.

## Common tasks

| Task | Where |
| --- | --- |
| Change the default persona | `SOUL.md` + `IDENTITY.md` |
| Change default hard rules | `AGENTS.md` **and** `src/agent/system-prompt.ts` |
| Tune proactive check-in behaviour | `HEARTBEAT.md` |
| Add a bootstrap file | `BOOTSTRAP_FILES` in `src/memory/workspace.ts` + the file here |
| Reset an installation's persona | Delete the file in `~/.crablite/workspace/` and restart |

## Notes

- The `agentName` config (default `Crab`) is what triggers group mentions; if you rename the agent
  in `IDENTITY.md`, set `CRABLITE_AGENT_NAME` to match or it will stop responding in groups.
- These files are the entire "hidden state" of the agent — which is the point: everything is
  readable and diffable Markdown.
