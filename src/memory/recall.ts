// Short-term recall tracking — the signal that drives "dreaming".
//
// Every time memory_search surfaces a line from a DAILY note (not MEMORY.md),
// we bump a counter keyed by that snippet. Frequently + diversely recalled
// snippets later graduate into MEMORY.md. Minimal port of OpenClaw's
// recordShortTermRecalls (short-term-promotion.ts:934-1045).

import crypto from "node:crypto";
import fs from "node:fs";
import { paths, writeJsonFileAtomic } from "../paths.js";
import { todayStamp } from "./workspace.js";

export type RecallEntry = {
  key: string;
  snippet: string;
  source: string; // "memory/YYYY-MM-DD.md:start-end"
  recallCount: number;
  maxScore: number;
  queryHashes: string[];
  recallDays: string[];
  firstSeen: string;
  lastRecalled: string;
  promotedAt?: string;
};

type RecallStore = { version: 1; entries: Record<string, RecallEntry> };

function load(): RecallStore {
  const file = paths.recallFile();
  if (!fs.existsSync(file)) return { version: 1, entries: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RecallStore;
  } catch {
    return { version: 1, entries: {} };
  }
}

function save(store: RecallStore): void {
  writeJsonFileAtomic(paths.recallFile(), store);
}

export function keyFor(snippet: string): string {
  return crypto.createHash("sha256").update(snippet.trim()).digest("hex").slice(0, 16);
}

function hashQuery(q: string): string {
  return crypto.createHash("sha256").update(q.trim().toLowerCase()).digest("hex").slice(0, 12);
}

/** Record a recall hit from a daily note. */
export function recordRecall(params: { snippet: string; source: string; score: number; query: string }): void {
  const snippet = params.snippet.trim();
  if (!snippet) return;
  const store = load();
  const key = keyFor(snippet);
  const day = todayStamp();
  const qh = hashQuery(params.query);

  const existing = store.entries[key];
  if (existing) {
    existing.recallCount += 1;
    existing.maxScore = Math.max(existing.maxScore, params.score);
    if (!existing.queryHashes.includes(qh)) existing.queryHashes.push(qh);
    if (!existing.recallDays.includes(day)) existing.recallDays.push(day);
    existing.lastRecalled = day;
    existing.source = params.source;
    existing.snippet = snippet;
  } else {
    store.entries[key] = {
      key,
      snippet,
      source: params.source,
      recallCount: 1,
      maxScore: params.score,
      queryHashes: [qh],
      recallDays: [day],
      firstSeen: day,
      lastRecalled: day,
    };
  }
  save(store);
}

export function allEntries(): RecallEntry[] {
  return Object.values(load().entries);
}

export function markPromoted(keys: string[]): void {
  const store = load();
  const day = todayStamp();
  for (const key of keys) {
    const entry = store.entries[key];
    if (entry) entry.promotedAt = day;
  }
  save(store);
}
