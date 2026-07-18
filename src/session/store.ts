// Durable sessions. Faithful to OpenClaw's model: a JSON index maps a stable
// sessionKey to a sessionId + transcript file; the transcript is append-only
// JSONL. We store Responses API items directly, so "resume" is just reloading
// the input array.
//
// Sessions are cached in-process after the first load, so a turn does not
// re-read and re-parse the whole (append-only, ever-growing) transcript on
// every message. Safe because this process is the transcript's only writer
// and withLock(chatId) serializes turns per chat; appendItems mutates the
// cached Session's items in place, keeping memory and disk consistent.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths, ensureDir, writeJsonFileAtomic } from "../paths.js";
import type { ResponseItem } from "../codex/responses.js";

type IndexEntry = {
  sessionId: string;
  file: string;
  createdAt: number;
  updatedAt: number;
  /** Transcript size (chars) at the last memory flush, to throttle re-flushing. */
  flushedChars?: number;
};
type SessionIndex = Record<string, IndexEntry>;

// Branded so a key can only come from sessionKeyFor — a hand-built string that
// drifts from the format would silently fork a chat's history between the
// reactive (handle) and proactive (heartbeat) paths.
export type SessionKey = string & { readonly __sessionKey: unique symbol };

/** The stable session key: one conversation per (channel, chatType, chatId). */
export function sessionKeyFor(
  channel: string,
  chatType: "direct" | "group",
  chatId: string,
): SessionKey {
  return `crablite:${channel}:${chatType}:${chatId}` as SessionKey;
}

export type Session = {
  sessionKey: SessionKey;
  sessionId: string;
  file: string;
  items: ResponseItem[]; // Responses API input items, in order
};

// One Session object per key; loadSession returns the cached object itself so
// every caller shares the same items array that appendItems keeps in sync.
const sessionCache = new Map<SessionKey, Session>();

/**
 * Test-facing (mirrors resetConfigCache): drop every cached session. Tests
 * swap CRABLITE_STATE_DIR per test and SessionKey does not include the state
 * dir, so a stale cache would leak one test's sessions into the next.
 */
export function resetSessionCache(): void {
  sessionCache.clear();
}

function readIndex(): SessionIndex {
  const file = paths.sessionsIndex();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SessionIndex;
  } catch {
    return {};
  }
}

function writeIndex(index: SessionIndex): void {
  writeJsonFileAtomic(paths.sessionsIndex(), index);
}

function transcriptFile(sessionId: string): string {
  return path.join(paths.sessionsDir(), `${sessionId}.jsonl`);
}

function loadItems(file: string): ResponseItem[] {
  if (!fs.existsSync(file)) return [];
  const items: ResponseItem[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "session") continue; // header line
      // Trust boundary: lines were written by appendItems, so the stored
      // shape IS ResponseItem; corrupt lines are skipped by the catch.
      if (parsed?.item) items.push(parsed.item as ResponseItem);
    } catch {
      /* skip corrupt line */
    }
  }
  return items;
}

export function loadSession(sessionKey: SessionKey): Session {
  const cached = sessionCache.get(sessionKey);
  if (cached) return cached;

  ensureDir(paths.sessionsDir());
  const index = readIndex();
  let entry = index[sessionKey];

  if (!entry) {
    const sessionId = crypto.randomUUID();
    const file = transcriptFile(sessionId);
    const now = Date.now();
    entry = { sessionId, file, createdAt: now, updatedAt: now };
    index[sessionKey] = entry;
    writeIndex(index);
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "session", sessionId, sessionKey, createdAt: now }) + "\n",
      { mode: 0o600 },
    );
  }

  const session: Session = {
    sessionKey,
    sessionId: entry.sessionId,
    file: entry.file,
    items: loadItems(entry.file),
  };
  sessionCache.set(sessionKey, session);
  return session;
}

/** Append items to the transcript (and in-memory list) and touch the index. */
export function appendItems(session: Session, items: ResponseItem[]): void {
  if (!items.length) return;
  const lines = items.map((item) => JSON.stringify({ ts: Date.now(), item }) + "\n").join("");
  fs.appendFileSync(session.file, lines);
  session.items.push(...items);

  const index = readIndex();
  const entry = index[session.sessionKey];
  if (entry) {
    entry.updatedAt = Date.now();
    writeIndex(index);
  }
}

/** Start a fresh conversation for this key (used by `/reset`). */
export function resetSession(sessionKey: SessionKey): void {
  sessionCache.delete(sessionKey); // the next loadSession starts fresh
  const index = readIndex();
  const entry = index[sessionKey];
  if (entry) {
    // Once the index entry is gone the old transcript is unreachable — delete
    // it so repeated /reset doesn't accumulate orphaned JSONL files forever.
    try {
      fs.unlinkSync(entry.file);
    } catch {
      /* best effort — may already be gone */
    }
  }
  delete index[sessionKey];
  writeIndex(index);
}

export function getFlushedChars(sessionKey: SessionKey): number {
  return readIndex()[sessionKey]?.flushedChars ?? 0;
}

export function setFlushedChars(sessionKey: SessionKey, chars: number): void {
  const index = readIndex();
  const entry = index[sessionKey];
  if (entry) {
    entry.flushedChars = chars;
    writeIndex(index);
  }
}
