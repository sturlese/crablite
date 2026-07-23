// Skills = folders with a SKILL.md. Progressive disclosure: only name +
// description + location go into the prompt; the model reads the body on demand
// via the `read` tool. Gated by requires.bins (skip if the CLI isn't installed).
//
// Faithful to OpenClaw (skills/skill-creator/SKILL.md, src/agents/skills/*),
// collapsed to two scan roots and a dependency-free frontmatter parse.

import fs from "node:fs";
import path from "node:path";
import { bundledSkillsDir, paths } from "../paths.js";
import { log } from "../logger.js";

export type Skill = {
  name: string;
  description: string;
  location: string; // absolute path to SKILL.md
  requiresBins: string[];
  eligible: boolean;
  learned: boolean; // self-written by the agent (metadata.crablite/openclaw.learned: true)
};

export function loadSkills(): Skill[] {
  const byName = new Map<string, Skill>();
  // Low → high precedence: bundled, then user workspace skills (workspace wins).
  for (const root of [bundledSkillsDir(), paths.skillsDir()]) {
    for (const skill of scanRoot(root)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scanRoot(root: string): Skill[] {
  if (!fs.existsSync(root)) return [];
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const skillMd = path.join(root, entry, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const skill = parseSkill(skillMd);
    if (skill) out.push(skill);
  }
  return out;
}

function parseSkill(file: string): Skill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = extractFrontmatter(raw);
  if (!fm) return null;
  const name = matchScalar(fm, "name") ?? path.basename(path.dirname(file));
  const description = matchScalar(fm, "description");
  if (!name || !description) {
    log.debug(`Skipping skill without name/description: ${file}`);
    return null;
  }
  const { bins, anyBins } = extractBins(fm);
  const requiresBins = [...new Set([...bins, ...anyBins])];
  // `bins` are ALL required (AND); `anyBins` need only ONE present (OR) — the
  // whole point of the separate key. Folding them together would make anyBins
  // behave like bins. Faithful to OpenClaw's resolveMissingAnyBins (some()).
  const eligible = bins.every(hasBinary) && (anyBins.length === 0 || anyBins.some(hasBinary));
  const learned = isLearned(fm);
  return { name, description, location: file, requiresBins, eligible, learned };
}

// --- minimal frontmatter parsing --------------------------------------------

function extractFrontmatter(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.slice(1).findIndex((l) => l.trim() === "---");
  if (end === -1) return null;
  return lines.slice(1, end + 1).join("\n");
}

function matchScalar(fm: string, key: string): string | undefined {
  const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "m"));
  if (!m) return undefined;
  return (
    m[1]!
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim() || undefined
  );
}

/**
 * True iff the frontmatter's metadata block sets `learned: true` — the provenance
 * marker a self-taught skill carries (see skills/skill-creator/SKILL.md). Regex-simple
 * like the rest of this parser: it doesn't care whether the key sits under
 * `metadata.crablite` or `metadata.openclaw`, only that a `learned: true` line exists
 * somewhere in the frontmatter (leading indentation allowed, unlike matchScalar).
 * Absent or any other value → false.
 */
function isLearned(fm: string): boolean {
  const m = fm.match(/^[ \t]*learned\s*:\s*(.+?)\s*$/m);
  return m !== null && m[1]!.replace(/^["']|["']$/g, "") === "true";
}

/**
 * Find bins/anyBins arrays in the frontmatter (JSON or YAML inline), keeping the
 * two apart: `bins` are all-required (AND), `anyBins` need only one (OR).
 */
function extractBins(fm: string): { bins: string[]; anyBins: string[] } {
  const bins = new Set<string>();
  const anyBins = new Set<string>();
  // Inline array form:  bins: ["gog"]  or  anyBins: ["gog", "curl"]
  for (const m of fm.matchAll(/["']?(any)?bins["']?\s*:\s*\[([^\]]*)\]/gi)) {
    const target = m[1] ? anyBins : bins;
    for (const tok of m[2]!.split(",")) {
      const b = tok.trim().replace(/^["']|["']$/g, "");
      if (b) target.add(b);
    }
  }
  // YAML dash-list form (parsed line-by-line — no backtracking regex):
  //   bins:
  //     - gog
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!.match(/^\s*(any)?bins\s*:\s*$/i);
    if (!head) continue;
    const target = head[1] ? anyBins : bins;
    for (let j = i + 1; j < lines.length; j++) {
      const dm = lines[j]!.match(/^\s*-\s*(.+?)\s*$/);
      if (!dm) break;
      const b = dm[1]!.replace(/^["']|["']$/g, "").trim();
      if (b) target.add(b);
    }
  }
  return { bins: [...bins], anyBins: [...anyBins] };
}

// --- binary presence check --------------------------------------------------

const binaryCache = new Map<string, boolean>();

export function hasBinary(bin: string): boolean {
  if (binaryCache.has(bin)) return binaryCache.get(bin)!;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  let found = false;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        found = true;
        break;
      } catch {
        /* keep looking */
      }
    }
    if (found) break;
  }
  binaryCache.set(bin, found);
  return found;
}

// --- prompt catalog ---------------------------------------------------------

/** Render the eligible skills as the <available_skills> catalog for the prompt. */
export function formatSkillCatalog(skills: Skill[]): string {
  const eligible = skills.filter((s) => s.eligible);
  if (eligible.length === 0) return "";
  const items = eligible
    .map(
      (s) =>
        `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.location}</location>\n  </skill>`,
    )
    .join("\n");
  return `<available_skills>\n${items}\n</available_skills>`;
}

// --- doctor formatting -------------------------------------------------------

/**
 * Render one skill's `crablite doctor` listing line, e.g. `✅ name (learned) (needs: a,b)`.
 * Caller (`cmdDoctor`) owns the leading indent/newline; this is just the line body.
 */
export function formatSkillLine(s: Skill): string {
  const learnedTag = s.learned ? " (learned)" : "";
  const needsTag = s.requiresBins.length ? ` (needs: ${s.requiresBins.join(",")})` : "";
  return `${s.eligible ? "✅" : "⏸ "} ${s.name}${learnedTag}${needsTag}`;
}

/**
 * Render the `crablite doctor` skills summary, e.g. `3 eligible / 4 found (1 learned)`. The
 * `(K learned)` suffix appears only when at least one skill is learned.
 */
export function formatSkillsSummary(skills: Skill[]): string {
  const learnedCount = skills.filter((s) => s.learned).length;
  const learnedSuffix = learnedCount > 0 ? ` (${learnedCount} learned)` : "";
  return `${skills.filter((s) => s.eligible).length} eligible / ${skills.length} found${learnedSuffix}`;
}
