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
  const requiresBins = extractBins(fm);
  const eligible = requiresBins.every(hasBinary);
  return { name, description, location: file, requiresBins, eligible };
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
  return m[1]!.trim().replace(/^["']|["']$/g, "").trim() || undefined;
}

/** Find bins/anyBins arrays anywhere in the frontmatter (JSON or YAML inline). */
function extractBins(fm: string): string[] {
  const bins = new Set<string>();
  // Inline array form:  bins: ["gog"]  or  "bins": ["gog", "curl"]
  for (const m of fm.matchAll(/["']?(?:any)?bins["']?\s*:\s*\[([^\]]*)\]/gi)) {
    for (const tok of m[1]!.split(",")) {
      const b = tok.trim().replace(/^["']|["']$/g, "");
      if (b) bins.add(b);
    }
  }
  // YAML dash-list form (parsed line-by-line — no backtracking regex):
  //   bins:
  //     - gog
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:any)?bins\s*:\s*$/i.test(lines[i]!)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const dm = lines[j]!.match(/^\s*-\s*(.+?)\s*$/);
      if (!dm) break;
      const b = dm[1]!.replace(/^["']|["']$/g, "").trim();
      if (b) bins.add(b);
    }
  }
  return [...bins];
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
