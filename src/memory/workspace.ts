// The workspace = the memory. All Markdown, user-inspectable. This module
// seeds the bootstrap files on first run and loads them (ordered, budgeted)
// into the system prompt's "# Project Context".
//
// Faithful to OpenClaw's CONTEXT_FILE_ORDER (system-prompt.ts:49-57).

import fs from "node:fs";
import path from "node:path";
import { paths, ensureDir, workspaceTemplateDir } from "../paths.js";

type BootstrapSpec = { name: string; order: number; inject: boolean };

// DREAMS.md / HEARTBEAT.md are seeded but never injected verbatim (DREAMS is a
// human diary; HEARTBEAT is read only by the proactive check-in).
export const BOOTSTRAP_FILES: BootstrapSpec[] = [
  { name: "AGENTS.md", order: 10, inject: true },
  { name: "SOUL.md", order: 20, inject: true },
  { name: "IDENTITY.md", order: 30, inject: true },
  { name: "USER.md", order: 40, inject: true },
  { name: "MEMORY.md", order: 70, inject: true },
  { name: "DREAMS.md", order: 998, inject: false },
  { name: "HEARTBEAT.md", order: 999, inject: false },
];

const PER_FILE_BUDGET = 12_000;

export type ProjectContextFile = { name: string; content: string };

/** Copy any missing bootstrap files from the shipped template. */
export function seedWorkspace(): void {
  const ws = paths.workspace();
  ensureDir(ws);
  ensureDir(paths.memoryDir());
  ensureDir(paths.skillsDir());

  const templateDir = workspaceTemplateDir();
  for (const { name } of BOOTSTRAP_FILES) {
    const dest = path.join(ws, name);
    if (fs.existsSync(dest)) continue;
    const src = path.join(templateDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else if (name === "MEMORY.md" || name === "DREAMS.md") {
      // These start empty if there's no template.
      fs.writeFileSync(dest, name === "MEMORY.md" ? "# Memory\n\n" : "# Dreams\n\n");
    }
  }
}

/** Load the injectable bootstrap files, ordered and per-file budgeted. */
export function loadProjectContext(): ProjectContextFile[] {
  const ws = paths.workspace();
  const files: (ProjectContextFile & { order: number })[] = [];
  for (const spec of BOOTSTRAP_FILES) {
    if (!spec.inject) continue;
    const file = path.join(ws, spec.name);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) continue;
    files.push({ name: spec.name, order: spec.order, content: budget(raw, PER_FILE_BUDGET) });
  }
  files.sort((a, b) => a.order - b.order);
  return files.map(({ name, content }) => ({ name, content }));
}

function budget(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n… [truncated ${text.length - max} chars — see the file on disk]`;
}

// --- daily notes ------------------------------------------------------------

export function todayStamp(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function dailyNotePath(stamp = todayStamp()): string {
  return path.join(paths.memoryDir(), `${stamp}.md`);
}

/** Append a block to today's daily note (creating it with a header). */
export function appendDailyNote(text: string): void {
  const file = dailyNotePath();
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${todayStamp()}\n\n`);
  }
  fs.appendFileSync(file, text.trim() + "\n\n");
}

/** List daily note files (absolute paths), newest first. */
export function listDailyNotes(): string[] {
  const dir = paths.memoryDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}(-.*)?\.md$/.test(f))
    .sort()
    .reverse()
    .map((f) => path.join(dir, f));
}

/**
 * Startup context: the last few days of daily notes, bounded. Injected at the
 * start of a fresh conversation so the agent knows what happened recently
 * without having to search. Mirrors OpenClaw's startup-context.ts.
 */
export function loadRecentDailyNotes(days = 2, maxTotalChars = 2_800, maxPerFile = 1_200): string {
  const files = listDailyNotes().slice(0, days + 2); // allow a couple of slugged files
  const blocks: string[] = [];
  let total = 0;
  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (!content) continue;
    if (content.length > maxPerFile) content = content.slice(0, maxPerFile) + " …";
    const block = `### ${path.basename(file)}\n${content}`;
    if (total + block.length > maxTotalChars) break;
    blocks.push(block);
    total += block.length;
  }
  return blocks.join("\n\n");
}
