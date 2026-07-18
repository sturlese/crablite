// Reminders = crablite's "commitments". When the agent commits to a follow-up
// ("I'll remind you tomorrow"), it calls schedule_reminder; the heartbeat loop
// delivers it proactively when due. This is OpenClaw's commitments → heartbeat
// delivery chain (src/commitments/*), with explicit (tool-driven) extraction
// instead of a hidden model pass — cheaper and just as effective.
//
// Delivery is AT-LEAST-ONCE: a reminder is a promise to the user, so losing one
// silently is worse than the rare duplicate. Two-phase protocol: the heartbeat
// claims a due reminder (claimReminder persists `deliveringAt` and counts the
// attempt) BEFORE sending, and confirms (markDelivered) only AFTER a send
// succeeded. A crash mid-delivery leaves a claim that goes stale after
// CLAIM_STALE_MS and becomes due again; MAX_DELIVERY_ATTEMPTS bounds retries.
// Exhausted reminders are stamped `abandonedAt` (sweepAbandoned) so the
// failure is logged exactly once — even when the final attempt died with the
// process — and listings can say "delivery failed" instead of "pending".

import crypto from "node:crypto";
import fs from "node:fs";
import { paths, writeJsonFileAtomic } from "../paths.js";
import type { Tool } from "./tool.js";

export type Reminder = {
  id: string;
  text: string;
  dueAt: number; // epoch ms
  chatId: string;
  chatType: "direct" | "group";
  createdAt: number;
  delivered?: boolean;
  /** Epoch ms of the last delivery claim (at-least-once protocol). Optional and additive: version-1 stores without it load unchanged. */
  deliveringAt?: number;
  /** Delivery attempts started (claims). Missing means 0. */
  attempts?: number;
  /** Epoch ms when retries were exhausted without a confirmed send. Terminal: never due again; shown as failed in listings. */
  abandonedAt?: number;
};

/**
 * How long a persisted claim blocks re-delivery — i.e. the post-CRASH retry
 * latency. This window is NOT what prevents same-process double-pickup: a
 * legal delivery turn can outlast it (idleTimeoutMs × maxToolRounds exceeds
 * 24 min at defaults); within one process the heartbeat's `running` guard is
 * the defense. The window only decides how soon a claim whose process died is
 * retried after restart. Spec floor is 10 min; 15 keeps rare long turns from
 * triggering a premature cross-restart retry without delaying recovery much.
 */
export const CLAIM_STALE_MS = 15 * 60_000;

/** Give up (stop retrying) after this many claimed delivery attempts. */
export const MAX_DELIVERY_ATTEMPTS = 3;

type Store = { version: 1; reminders: Reminder[] };

// NOTE: every store function below is a synchronous load → mutate → save with
// no `await` inside. That property is load-bearing: it is what makes heartbeat
// ticks and tool calls interleaving-safe on this file. Keep it that way.
function load(): Store {
  const file = paths.remindersFile();
  if (!fs.existsSync(file)) return { version: 1, reminders: [] };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Store;
  } catch {
    return { version: 1, reminders: [] };
  }
}

function save(store: Store): void {
  writeJsonFileAtomic(paths.remindersFile(), store);
}

export function addReminder(
  r: Omit<Reminder, "id" | "createdAt" | "delivered" | "deliveringAt" | "attempts" | "abandonedAt">,
): Reminder {
  const store = load();
  const reminder: Reminder = { ...r, id: crypto.randomUUID(), createdAt: Date.now() };
  store.reminders.push(reminder);
  save(store);
  return reminder;
}

/**
 * The reminders eligible for a delivery attempt NOW: undelivered, due,
 * not freshly claimed (unclaimed, or the claim is at least CLAIM_STALE_MS old),
 * and not out of attempts. This is the single operational filter — delivery
 * must never select reminders any other way.
 */
export function dueReminders(now = Date.now()): Reminder[] {
  return load().reminders.filter(
    (r) =>
      !r.delivered &&
      !r.abandonedAt &&
      r.dueAt <= now &&
      (r.attempts ?? 0) < MAX_DELIVERY_ATTEMPTS &&
      (r.deliveringAt === undefined || now - r.deliveringAt >= CLAIM_STALE_MS),
  );
}

/**
 * Every undelivered reminder (used by `doctor` and `list_schedules`).
 * Claimed-but-unconfirmed reminders are still pending (the promise is not kept
 * until markDelivered records a successful send); abandoned reminders stay
 * listed too — annotated as failed by list_schedules and cancellable by id —
 * rather than silently vanishing.
 */
export function pendingReminders(chatId?: string): Reminder[] {
  return load().reminders.filter((r) => !r.delivered && (!chatId || r.chatId === chatId));
}

/**
 * Stamp every reminder that exhausted its delivery attempts without a
 * confirmed send and has no abandonment record yet — including ones whose
 * final attempt died with the process (crash, drain-timeout kill). Returns
 * only the newly stamped reminders; the abandonedAt guard makes repeated
 * sweeps idempotent, so the caller can log each abandonment exactly once.
 */
export function sweepAbandoned(now = Date.now()): Reminder[] {
  const store = load();
  const newly = store.reminders.filter(
    (r) => !r.delivered && !r.abandonedAt && (r.attempts ?? 0) >= MAX_DELIVERY_ATTEMPTS,
  );
  if (newly.length === 0) return [];
  for (const r of newly) r.abandonedAt = now;
  save(store);
  return newly;
}

/**
 * Phase 1 of at-least-once delivery: persist the claim and count the attempt
 * BEFORE trying to send, so a crash mid-delivery leaves a visible stale claim
 * (retried later) instead of a silently lost promise. Returns the updated
 * reminder (authoritative attempt count) or null if the id is unknown.
 */
export function claimReminder(id: string, now = Date.now()): Reminder | null {
  const store = load();
  const r = store.reminders.find((x) => x.id === id);
  if (!r) return null;
  r.deliveringAt = now;
  r.attempts = (r.attempts ?? 0) + 1;
  save(store);
  return r;
}

/** Phase 2 (confirm): call ONLY after a send actually succeeded. */
export function markDelivered(id: string): void {
  const store = load();
  const r = store.reminders.find((x) => x.id === id);
  if (r) {
    r.delivered = true;
    save(store);
  }
}

/** Remove a pending reminder by id. Returns the removed reminder, or null. */
export function removeReminder(id: string): Reminder | null {
  const store = load();
  const idx = store.reminders.findIndex((r) => r.id === id && !r.delivered);
  if (idx === -1) return null;
  const [removed] = store.reminders.splice(idx, 1);
  save(store);
  return removed ?? null;
}

// --- the model-facing tool --------------------------------------------------

export const scheduleReminderTool: Tool = {
  name: "schedule_reminder",
  description:
    "Schedule a proactive reminder / follow-up. Call this whenever you commit to getting back to " +
    "the user later ('I'll remind you tomorrow', 'let's revisit this on Friday'). It will message " +
    "the user in THIS chat when due. Provide `text` and either `at` (ISO 8601 timestamp — compute it " +
    "from the current date/time shown in Runtime) or `inMinutes`.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "What to remind the user about." },
      at: { type: "string", description: "ISO 8601 datetime, e.g. 2026-07-11T09:00:00." },
      inMinutes: { type: "number", description: "Alternatively, minutes from now." },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!ctx.chatId || !ctx.chatType) return "Cannot schedule a reminder outside a chat.";
    const text = String(args.text ?? "").trim();
    if (!text) return "ERROR: empty reminder text.";
    let dueAt: number;
    if (args.at) {
      dueAt = Date.parse(String(args.at));
      if (Number.isNaN(dueAt)) return `ERROR: could not parse date "${args.at}". Use ISO 8601.`;
    } else {
      const minutes = Number(args.inMinutes ?? 60);
      // Math.max(1, NaN) is NaN, so a non-numeric inMinutes would otherwise
      // yield dueAt=NaN: the reminder is "set" but never becomes due. Guard it
      // the same way the `at` branch guards an unparseable date.
      if (!Number.isFinite(minutes)) {
        return `ERROR: could not parse inMinutes "${args.inMinutes}". Provide a number of minutes.`;
      }
      dueAt = Date.now() + Math.max(1, minutes) * 60_000;
    }
    const r = addReminder({ text, dueAt, chatId: ctx.chatId, chatType: ctx.chatType });
    return `Reminder set for ${new Date(r.dueAt).toLocaleString()}: "${text}".`;
  },
};
