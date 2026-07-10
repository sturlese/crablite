// Reminders = crablite's "commitments". When the agent commits to a follow-up
// ("I'll remind you tomorrow"), it calls schedule_reminder; the heartbeat loop
// delivers it proactively when due. This is OpenClaw's commitments → heartbeat
// delivery chain (src/commitments/*), with explicit (tool-driven) extraction
// instead of a hidden model pass — cheaper and just as effective.

import crypto from "node:crypto";
import fs from "node:fs";
import { paths, writeJsonFileAtomic } from "../paths.js";
import type { Tool } from "./tools.js";

export type Reminder = {
  id: string;
  text: string;
  dueAt: number; // epoch ms
  chatId: string;
  chatType: "direct" | "group";
  createdAt: number;
  delivered?: boolean;
};

type Store = { version: 1; reminders: Reminder[] };

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

export function addReminder(r: Omit<Reminder, "id" | "createdAt" | "delivered">): Reminder {
  const store = load();
  const reminder: Reminder = { ...r, id: crypto.randomUUID(), createdAt: Date.now() };
  store.reminders.push(reminder);
  save(store);
  return reminder;
}

export function dueReminders(now = Date.now()): Reminder[] {
  return load().reminders.filter((r) => !r.delivered && r.dueAt <= now);
}

export function pendingReminders(chatId?: string): Reminder[] {
  return load().reminders.filter((r) => !r.delivered && (!chatId || r.chatId === chatId));
}

export function markDelivered(id: string): void {
  const store = load();
  const r = store.reminders.find((x) => x.id === id);
  if (r) {
    r.delivered = true;
    save(store);
  }
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
      dueAt = Date.now() + Math.max(1, Number(args.inMinutes ?? 60)) * 60_000;
    }
    const r = addReminder({ text, dueAt, chatId: ctx.chatId, chatType: ctx.chatType });
    return `Reminder set for ${new Date(r.dueAt).toLocaleString()}: "${text}".`;
  },
};
