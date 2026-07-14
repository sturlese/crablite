// "Dreaming" — the self-learning loop. Frequently + diversely recalled daily
// notes graduate into always-loaded MEMORY.md, with provenance and an
// idempotency marker, and a first-person entry is written to DREAMS.md.
//
// Distilled from OpenClaw's short-term-promotion.ts (ranking :56-64,
// applyShortTermPromotions :1614-1766) and memory-budget.ts:116-164 — but with
// zero database: just Markdown + one JSON recall file.

import fs from "node:fs";
import path from "node:path";
import { paths, resolveInside } from "../paths.js";
import { allEntries, markPromoted, type RecallEntry } from "./recall.js";
import { todayStamp } from "./workspace.js";
import { callModel, userItem } from "../codex/responses.js";
import { log } from "../logger.js";

// Ranking weights (sum ≈ 1.0), mirroring OpenClaw's blend.
const W = { relevance: 0.3, frequency: 0.24, diversity: 0.15, recency: 0.15, consolidation: 0.16 };
// Promotion gates.
const MIN_SCORE = 0.5;
const MIN_RECALL_COUNT = 3;
const MIN_UNIQUE_QUERIES = 2;
const MEMORY_BUDGET_CHARS = 10_000;
const PROMOTION_HEADING = "## Promoted From Short-Term Memory";

function daysBetween(a: string, b: string): number {
  const da = Date.parse(a + "T00:00:00Z");
  const db = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.abs(db - da) / 86_400_000;
}

function scoreEntry(e: RecallEntry, today: string): number {
  const relevance = clamp01(e.maxScore);
  const frequency = clamp01(e.recallCount / 8);
  const diversity = clamp01(e.queryHashes.length / 4);
  const recency = 0.5 ** (daysBetween(e.lastRecalled, today) / 14);
  const consolidation = clamp01((e.recallDays.length - 1) / 3);
  return (
    W.relevance * relevance +
    W.frequency * frequency +
    W.diversity * diversity +
    W.recency * recency +
    W.consolidation * consolidation
  );
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function passesGates(e: RecallEntry): boolean {
  return (
    !e.promotedAt && e.recallCount >= MIN_RECALL_COUNT && e.queryHashes.length >= MIN_UNIQUE_QUERIES
  );
}

function parseSource(source: string): { file: string; start: number; end: number } | null {
  const m = source.match(/^(.*):(\d+)-(\d+)$/);
  if (!m) return null;
  return { file: m[1]!, start: Number(m[2]), end: Number(m[3]) };
}

/** Re-read the snippet from its live daily file; return current text or null if gone. */
function rehydrate(e: RecallEntry): string | null {
  const parsed = parseSource(e.source);
  if (!parsed) return null;
  let abs: string;
  try {
    // `source` comes from .recall.json (agent-writable) — contain it.
    abs = resolveInside(paths.workspace(), parsed.file);
  } catch {
    return null;
  }
  if (!fs.existsSync(abs)) return null;
  const content = fs.readFileSync(abs, "utf8");
  const lines = content.split("\n");
  const atRange = lines
    .slice(parsed.start - 1, parsed.end)
    .join("\n")
    .trim();

  // Prefer the recorded range if it still overlaps the snippet.
  const probe = e.snippet.trim().slice(0, 50);
  if (atRange && (atRange.includes(probe) || e.snippet.includes(atRange.slice(0, 50)))) {
    return atRange;
  }
  // Otherwise, if the snippet text still exists somewhere in the file, keep it.
  if (probe && content.includes(probe)) return e.snippet.trim();
  return null;
}

function existingMarkers(memoryPath: string): Set<string> {
  if (!fs.existsSync(memoryPath)) return new Set();
  const markers = new Set<string>();
  const content = fs.readFileSync(memoryPath, "utf8");
  for (const m of content.matchAll(/crablite-promotion:([a-f0-9]+)/g)) markers.add(m[1]!);
  return markers;
}

/** Drop oldest promotion sections until MEMORY.md fits the budget. User content is never touched. */
function compactMemory(memoryPath: string): void {
  if (!fs.existsSync(memoryPath)) return;
  const content = fs.readFileSync(memoryPath, "utf8");
  if (content.length <= MEMORY_BUDGET_CHARS) return;

  const idx = content.indexOf(PROMOTION_HEADING);
  if (idx === -1) return; // nothing but user content — leave it alone
  const preamble = content.slice(0, idx);
  const rest = content.slice(idx);

  // Split into promotion sections (each starts with the heading).
  const sections = rest.split(new RegExp(`(?=${PROMOTION_HEADING})`)).filter((s) => s.trim());

  while (preamble.length + sections.join("").length > MEMORY_BUDGET_CHARS && sections.length > 0) {
    sections.shift(); // drop the oldest (file order = chronological)
  }
  fs.writeFileSync(memoryPath, (preamble + sections.join("")).trimEnd() + "\n");
}

export type DreamResult = { promoted: number; skipped: number; details: string[] };

/**
 * Run one dreaming sweep. `model` (optional) is used only for a best-effort
 * reflective diary line; promotion itself needs no model.
 */
export async function runDreaming(model?: string): Promise<DreamResult> {
  const today = todayStamp();
  const memoryPath = path.join(paths.workspace(), "MEMORY.md");
  const dreamsPath = path.join(paths.workspace(), "DREAMS.md");
  const markers = existingMarkers(memoryPath);

  const candidates = allEntries()
    .filter(passesGates)
    .map((e) => ({ e, score: scoreEntry(e, today) }))
    .filter((c) => c.score >= MIN_SCORE && !markers.has(c.e.key))
    .sort((a, b) => b.score - a.score);

  const details: string[] = [];
  const bullets: string[] = [];
  const promotedKeys: string[] = [];
  let skipped = 0;

  for (const { e, score } of candidates) {
    const text = rehydrate(e);
    if (!text) {
      skipped++;
      continue;
    }
    const oneLine = text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-*]\s+/, "");
    bullets.push(
      `<!-- crablite-promotion:${e.key} -->\n- ${oneLine} ` +
        `\`[score=${score.toFixed(2)} recalls=${e.recallCount} source=${e.source}]\``,
    );
    promotedKeys.push(e.key);
    details.push(`${oneLine.slice(0, 80)} (score ${score.toFixed(2)})`);
  }

  if (bullets.length === 0) {
    log.info("Dreaming: nothing to promote tonight.");
    return { promoted: 0, skipped, details };
  }

  // 1) Append the promotion section to MEMORY.md.
  ensureFile(memoryPath, "# Memory\n\n");
  fs.appendFileSync(memoryPath, `\n${PROMOTION_HEADING} (${today})\n\n${bullets.join("\n\n")}\n`);
  compactMemory(memoryPath);

  // compactMemory evicts whole promotion sections that don't fit the budget —
  // including the one we just appended, when user content alone fills MEMORY.md.
  // If our section didn't survive, it was never actually stored: don't mark the
  // entries promoted (which would bar them forever) or claim we consolidated them.
  const stored = existingMarkers(memoryPath);
  if (!promotedKeys.some((k) => stored.has(k))) {
    log.info("Dreaming: memory budget is full of user content; promotions could not be stored.");
    return { promoted: 0, skipped, details };
  }

  // 2) Write a DREAMS.md diary entry (best-effort reflective line via the model).
  const reflection = await reflect(model, details);
  ensureFile(dreamsPath, "# Dreams\n\n");
  fs.appendFileSync(
    dreamsPath,
    `## ${today}\n\n${reflection}\n\n` + details.map((d) => `- ${d}`).join("\n") + "\n\n",
  );

  // 3) Mark promoted so we don't re-promote.
  markPromoted(promotedKeys);
  log.info(`Dreaming: promoted ${promotedKeys.length} memories, skipped ${skipped}.`);
  return { promoted: promotedKeys.length, skipped, details };
}

async function reflect(model: string | undefined, details: string[]): Promise<string> {
  const fallback = `Tonight I consolidated ${details.length} thing(s) I kept coming back to into long-term memory.`;
  if (!model) return fallback;
  try {
    const res = await callModel({
      model,
      instructions:
        "You are the agent writing a short, first-person diary line about what you learned and " +
        "moved into long-term memory today. One or two warm, reflective sentences. No lists.",
      input: [userItem(details.join("\n"))],
      tools: [],
      idleTimeoutMs: 30_000,
    });
    return res.text.trim() || fallback;
  } catch {
    return fallback;
  }
}

function ensureFile(file: string, initial: string): void {
  if (!fs.existsSync(file)) fs.writeFileSync(file, initial);
}
