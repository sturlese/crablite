# skills — bundled skills

## Purpose

Skills shipped with the package. A skill is a folder with a `SKILL.md`: documentation the model
reads on demand and follows, usually by running commands through the `exec` tool. There is no skill
runtime — that is the design.

Loaded by `src/skills/loader.ts` at **lower** precedence than the user's
`~/.crablite/workspace/skills/`, so a user can override any of these by name.

## Key entry points

| Skill | Requires | What it covers |
| --- | --- | --- |
| `gog/` | `gog` | Google Workspace: Gmail (search, read, summarize, **draft → confirm → send**) and Sheets (get/update/append/clear), plus Calendar/Drive/Docs. |
| `pdf/` | `pdftotext` | Read/summarize/answer questions about a PDF (typically one saved to `inbox/`). |
| `skill-creator/` | — | Turn a taught workflow into a workspace `SKILL.md` — propose → explicit confirm → write; tags it `metadata.crablite.learned: true`. Forgetting = break the frontmatter fence via `write`, never `exec rm`. |
| `weather/` | `curl` | Current weather / short forecast. |
| `web-search/` | — | Search and read pages using the built-in `web_fetch` tool. |

`crablite doctor` prints which skills are found and which are eligible on this machine.

## Use these

- **Write the `description` as a trigger sentence.** It is the *only* text the model sees up front
  ("Use this whenever …"). Everything else is read on demand.
- **Gate on binaries** with `metadata.crablite.requires.bins` (all required) or `anyBins` (at least
  one). An ungated skill that needs a missing CLI will be attempted and fail.
- **Reuse the built-in tools** in the body: `exec` for CLIs, `web_fetch` for pages, `read` for
  files, `send_file` to deliver results. See `web-search/SKILL.md` for a skill that needs no binary
  at all.
- **State the confirmation policy in the skill** when it can act outward — `gog/SKILL.md` opens
  with its sending policy for exactly this reason.

## Avoid / anti-patterns

- Do **not** duplicate hard policy here. Global rules live in `src/agent/system-prompt.ts` and the
  user-editable `workspace-template/AGENTS.md`. *"Skills own workflows; root owns hard policy and
  routing."*
- Do **not** write a skill that sends email/messages or creates calendar events without an explicit
  user "yes". Draft first, show, then send.
- Do **not** put secrets, tokens or account ids in a `SKILL.md`. These files are shipped and are
  read into the model context.
- Do **not** write a long generic preamble. The model loads at most one skill up front; keep the
  body a checklist of concrete commands.
- Do **not** add TypeScript to implement a skill. If it needs code, it needs a binary and a
  `requires.bins` gate.

## Data & contracts

```yaml
---
name: <folder-name>
description: <one sentence trigger — the only always-in-context text>
metadata:
  crablite:            # metadata.openclaw is also honored (OpenClaw skills drop in unchanged)
    learned: true          # provenance marker skill-creator writes on anything self-taught; omit on hand-authored skills
    requires:
      bins: ["gog"]        # ALL must be present
      anyBins: ["a","b"]   # at LEAST ONE must be present
---
```

The catalog injected into the prompt is `<available_skills><skill><name><description><location>`,
where `location` is the absolute path to `SKILL.md`. `src/paths.ts` `resolveReadable` allows this
directory so the `read` tool can open it.

## Tests

Parsing, gating and precedence — including the `learned` provenance flag — are covered by
`test/loader.test.ts`, which also confirms `skill-creator` itself parses eligible, binary-free, and
not learned (it's the bundled tool, not a self-taught skill). The skill *bodies* are prose and are
not tested — validate them by using them (`pnpm crablite chat`).

## Common tasks

| Task | Where |
| --- | --- |
| Add a bundled skill | New folder + `SKILL.md` here; verify with `crablite doctor` |
| Let a user customize a shipped skill | Copy it to `~/.crablite/workspace/skills/<name>/` (overrides by name) |
| A user teaches a new skill | The bundled `skill-creator/` skill proposes, confirms, then writes to `~/.crablite/workspace/skills/<name>/` |
| A skill is hidden | Its `requires.bins` binary is not on `PATH` — check `crablite doctor` |
| Change how skills reach the prompt | `src/skills/loader.ts` + the "## Skills" section of `src/agent/system-prompt.ts` |

## Notes

- `skill-creator/SKILL.md` never carries `learned: true` itself — it's the bundled tool that writes
  that marker onto *other* skills, not a self-taught one.
- `gog/SKILL.md` documents a one-time OAuth setup the *user* performs; the agent must never be
  asked to run it silently.
- `pdf` is gated on `pdftotext` (poppler), baked into the Docker image. Locally, install poppler or
  the skill stays hidden.
- Deployment/setup details for `gog` live in `docs/deployment.md`.
