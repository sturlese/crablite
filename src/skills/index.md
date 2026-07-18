# src/skills — skill discovery and gating

## Purpose

A skill is a folder containing a `SKILL.md`. This module finds them, parses the frontmatter, hides
the ones whose required binaries are missing, and renders the catalog that goes into the system
prompt. Progressive disclosure: only name + description + location are always in context; the
model reads the body on demand with the `read` tool.

## Key entry points

`loader.ts` is the whole directory.

| Export | Role |
| --- | --- |
| `loadSkills()` | Scan both roots, parse, dedupe by name, sort. Returns `Skill[]`. |
| `formatSkillCatalog(skills)` | Render eligible skills as `<available_skills>` XML for the prompt. |
| `hasBinary(bin)` | Cached `PATH` lookup (also used by `crablite doctor`). |

## Use these

- **`loadSkills()` + `formatSkillCatalog()`** together — `agent/runner.ts` shows the pattern.
- **`hasBinary`** for any "is this CLI installed?" check; it caches per process.
- **`bundledSkillsDir()` / `paths.skillsDir()`** (from `../paths.js`) for the two scan roots.

## Avoid / anti-patterns

- Do **not** collapse `bins` and `anyBins`. `bins` are **all** required (AND); `anyBins` need only
  **one** present (OR). Folding them together silently makes `anyBins` behave like `bins` — there
  is a comment in `parseSkill` about exactly this.
- Do **not** put ineligible skills in the catalog. A skill whose binary is missing must be
  invisible to the model, otherwise it will try and fail.
- Do **not** add a YAML dependency. The frontmatter parse is deliberately minimal (inline arrays +
  dash lists, no backtracking regex). If a skill needs richer metadata, reconsider the skill.
- Do **not** let the model guess skill paths. The catalog carries an absolute `<location>`, and
  `resolveReadable` allows the bundled skills dir precisely so that path opens — the prompt says
  "never guess or fabricate skill paths".
- Do **not** invert precedence. Workspace skills (`~/.crablite/workspace/skills/`) override
  bundled ones with the same name; that is how a user customizes a shipped skill.

## Data & contracts

```ts
Skill = { name; description; location /* absolute path to SKILL.md */; requiresBins: string[]; eligible }
```

`SKILL.md` frontmatter (YAML between `---` fences):

```yaml
---
name: weather
description: One sentence. This is the ONLY text the model sees up front — make it a trigger.
metadata:
  crablite:          # metadata.openclaw is also honored, so OpenClaw skills drop in unchanged
    requires:
      bins: ["curl"]     # all required
      anyBins: ["a","b"] # at least one required
---
```

Scan roots, low → high precedence: `<packageRoot>/skills/`, then
`~/.crablite/workspace/skills/`.

## Tests

`test/loader.test.ts` — frontmatter parsing (both array forms), the AND/OR distinction between
`bins` and `anyBins`, precedence between roots, catalog rendering, skipping folders without
name/description.

## Common tasks

| Task | Where |
| --- | --- |
| Add a bundled skill | New folder under `/skills` with a `SKILL.md` (see `/skills/index.md`) |
| Add a frontmatter key | `parseSkill` + `extractBins`-style helper; keep it regex-simple |
| Change the prompt catalog shape | `formatSkillCatalog` + the "## Skills" section of `agent/system-prompt.ts` |
| Debug why a skill is hidden | `crablite doctor` lists found vs eligible skills and missing bins |

## Notes

- The binary cache is process-lifetime. A long-running WhatsApp process will not notice a CLI
  installed after startup — restart to pick it up.
- Skills act through the `exec` tool; there is no skill runtime. That is the whole point: a skill is
  documentation the model follows.
