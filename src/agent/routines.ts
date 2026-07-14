// Routines — recurring commitments, OpenClaw's cron distilled. A routine is a
// standing instruction the agent schedules for itself in conversation ("every
// morning at 8, brief me"); the heartbeat runs due ones as proactive turns in
// their chat. Schedules are structured (daily/weekly/every) instead of cron
// expressions — friendlier for the model and dependency-free — and use LOCAL
// wall-clock time, like dreamHour/heartbeatHour. Missed occurrences are not
// replayed: after a run (or a downtime gap) the next run is computed from
// "now", mirroring OpenClaw's reschedule-instead-of-replay policy.

import crypto from "node:crypto";
import fs from "node:fs";
import { paths, writeJsonFileAtomic } from "../paths.js";

export type RoutineSchedule =
  | { kind: "daily"; at: string } // "HH:MM" local
  | { kind: "weekly"; weekday: number; at: string } // 0 = Sunday … 6 = Saturday
  | { kind: "every"; minutes: number };

export type Routine = {
  id: string; // short id, chat-friendly
  text: string; // the standing instruction for the agent's future self
  schedule: RoutineSchedule;
  chatId: string;
  chatType: "direct" | "group";
  createdAt: number;
  nextRunAt: number; // epoch ms
  lastRunAt?: number;
};

type Store = { version: 1; routines: Routine[] };

export const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export const MIN_EVERY_MINUTES = 5;

function load(): Store {
  const file = paths.routinesFile();
  if (!fs.existsSync(file)) return { version: 1, routines: [] };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Store;
  } catch {
    return { version: 1, routines: [] };
  }
}

function save(store: Store): void {
  writeJsonFileAtomic(paths.routinesFile(), store);
}

/** Parse "HH:MM" (24h). Returns null when malformed or out of range. */
export function parseAt(at: string): { hour: number; minute: number } | null {
  const m = at.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * The next occurrence of `schedule` strictly after `from`, in local time.
 * Recomputing from "now" on every advance keeps wall-clock schedules correct
 * across DST changes and downtime.
 */
export function computeNextRun(schedule: RoutineSchedule, from = Date.now()): number {
  if (schedule.kind === "every") {
    return from + Math.max(MIN_EVERY_MINUTES, schedule.minutes) * 60_000;
  }
  const at = parseAt(schedule.at);
  if (!at) throw new Error(`Invalid routine time "${schedule.at}" (expected HH:MM).`);
  const d = new Date(from);
  d.setHours(at.hour, at.minute, 0, 0);
  if (schedule.kind === "daily") {
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // weekly
  const delta = (schedule.weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  if (d.getTime() <= from) d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** Human-readable schedule, for confirmations and list_schedules. */
export function describeSchedule(s: RoutineSchedule): string {
  if (s.kind === "daily") return `daily at ${s.at}`;
  if (s.kind === "weekly") {
    const name = WEEKDAY_NAMES[s.weekday] ?? `weekday ${s.weekday}`;
    return `every ${name[0]!.toUpperCase()}${name.slice(1)} at ${s.at}`;
  }
  return `every ${Math.max(MIN_EVERY_MINUTES, s.minutes)} minutes`;
}

export function addRoutine(
  params: Omit<Routine, "id" | "createdAt" | "nextRunAt" | "lastRunAt">,
): Routine {
  const store = load();
  const routine: Routine = {
    ...params,
    id: crypto.randomUUID().slice(0, 8),
    createdAt: Date.now(),
    nextRunAt: computeNextRun(params.schedule),
  };
  store.routines.push(routine);
  save(store);
  return routine;
}

export function allRoutines(): Routine[] {
  return load().routines;
}

export function dueRoutines(now = Date.now()): Routine[] {
  return load().routines.filter((r) => r.nextRunAt <= now);
}

/** Remove a routine by id. Returns the removed routine, or null if unknown. */
export function removeRoutine(id: string): Routine | null {
  const store = load();
  const idx = store.routines.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = store.routines.splice(idx, 1);
  save(store);
  return removed ?? null;
}

/**
 * Mark a routine as run "now" and schedule its next occurrence. Called BEFORE
 * the proactive turn executes, so a crash mid-turn skips to the next
 * occurrence instead of double-running.
 */
export function advanceRoutine(id: string, now = Date.now()): void {
  const store = load();
  const routine = store.routines.find((r) => r.id === id);
  if (!routine) return;
  routine.lastRunAt = now;
  routine.nextRunAt = computeNextRun(routine.schedule, now);
  save(store);
}
