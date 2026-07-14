// The schedule-management tools: create recurring routines, and list/cancel
// everything scheduled (one-shot reminders + routines) so a commitment is
// never a conversational dead-end. Params are FLAT on purpose — OpenClaw's
// cron tool spells out every field instead of nested unions so the model
// knows exactly what to send; we keep that lesson.

import { pendingReminders, removeReminder } from "./reminders.js";
import {
  addRoutine,
  allRoutines,
  describeSchedule,
  parseAt,
  removeRoutine,
  MIN_EVERY_MINUTES,
  WEEKDAY_NAMES,
  type RoutineSchedule,
} from "./routines.js";
import type { Tool } from "./tool.js";

const scheduleRoutineTool: Tool = {
  name: "schedule_routine",
  description:
    "Create a RECURRING routine — a standing instruction you will receive again and again on a " +
    "schedule (daily at a time, weekly on a weekday, or every N minutes). Use it when the user asks " +
    "for something repeating ('every morning…', 'each Monday…', 'check X every few hours'); for a " +
    "one-off follow-up use schedule_reminder instead. Write `text` as a complete instruction to " +
    "your future self — it fires in this chat with no other context.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The standing instruction to execute each time the routine fires. Self-contained. If it " +
          "is a check ('look for urgent emails'), say what to do when there is nothing to report.",
      },
      kind: { type: "string", enum: ["daily", "weekly", "every"], description: "Schedule type." },
      at: { type: "string", description: 'Local time "HH:MM" (24h). Required for daily/weekly.' },
      weekday: {
        type: "string",
        enum: [...WEEKDAY_NAMES],
        description: "Day of the week. Required for weekly.",
      },
      everyMinutes: {
        type: "number",
        description: `Interval in minutes (min ${MIN_EVERY_MINUTES}). Required for kind=every.`,
      },
    },
    required: ["text", "kind"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!ctx.chatId || !ctx.chatType) return "Cannot schedule a routine outside a chat.";
    const text = String(args.text ?? "").trim();
    if (!text) return "ERROR: empty routine text.";

    const schedule = parseScheduleArgs(args);
    if (typeof schedule === "string") return schedule; // validation error

    const r = addRoutine({ text, schedule, chatId: ctx.chatId, chatType: ctx.chatType });
    return (
      `Routine [${r.id}] set (${describeSchedule(r.schedule)}), ` +
      `next run ${new Date(r.nextRunAt).toLocaleString()}: "${text}".`
    );
  },
};

/** Validate the flat schedule args; return a RoutineSchedule or an error string. */
function parseScheduleArgs(args: any): RoutineSchedule | string {
  const kind = String(args.kind ?? "");
  if (kind === "daily" || kind === "weekly") {
    const at = String(args.at ?? "").trim();
    if (!parseAt(at)) return `ERROR: invalid or missing \`at\` "${args.at}". Use 24h HH:MM.`;
    if (kind === "daily") return { kind, at };
    const name = String(args.weekday ?? "")
      .trim()
      .toLowerCase();
    const weekday = (WEEKDAY_NAMES as readonly string[]).indexOf(name);
    if (weekday === -1) {
      return `ERROR: invalid or missing \`weekday\` "${args.weekday}". Use monday…sunday.`;
    }
    return { kind, weekday, at };
  }
  if (kind === "every") {
    const minutes = Number(args.everyMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return `ERROR: invalid \`everyMinutes\` "${args.everyMinutes}". Provide a number of minutes.`;
    }
    return { kind, minutes: Math.max(MIN_EVERY_MINUTES, Math.floor(minutes)) };
  }
  return 'ERROR: `kind` must be "daily", "weekly" or "every".';
}

const listSchedulesTool: Tool = {
  name: "list_schedules",
  description:
    "List everything currently scheduled: pending one-shot reminders and recurring routines, with " +
    "their ids. Use it before canceling, or when the user asks what is scheduled.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const reminders = pendingReminders();
    const routines = allRoutines();
    if (reminders.length === 0 && routines.length === 0) {
      return "Nothing is scheduled — no pending reminders, no routines.";
    }
    const out: string[] = [];
    const chatLabel = (chatId: string) =>
      ctx.chatId && chatId !== ctx.chatId ? ` (chat ${chatId})` : "";
    if (reminders.length) {
      out.push("Reminders (one-shot):");
      for (const r of reminders) {
        out.push(
          `- [${r.id.slice(0, 8)}] due ${new Date(r.dueAt).toLocaleString()}${chatLabel(r.chatId)} — "${r.text}"`,
        );
      }
    }
    if (routines.length) {
      if (out.length) out.push("");
      out.push("Routines (recurring):");
      for (const r of routines) {
        out.push(
          `- [${r.id}] ${describeSchedule(r.schedule)}, next ${new Date(r.nextRunAt).toLocaleString()}${chatLabel(r.chatId)} — "${r.text}"`,
        );
      }
    }
    return out.join("\n");
  },
};

const cancelScheduleTool: Tool = {
  name: "cancel_schedule",
  description:
    "Cancel a scheduled item by id — works for both one-shot reminders and recurring routines. " +
    "Get the id from list_schedules (or from the confirmation shown when it was created).",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The id shown in [brackets]." } },
    required: ["id"],
    additionalProperties: false,
  },
  async execute(args) {
    const id = String(args.id ?? "").trim();
    if (!id) return "ERROR: empty id.";
    const routine = removeRoutine(id);
    if (routine)
      return `Canceled routine [${routine.id}] (${describeSchedule(routine.schedule)}): "${routine.text}".`;
    // Reminder ids are UUIDs but shown truncated to 8 chars — match either.
    const match = pendingReminders().find((r) => r.id === id || r.id.startsWith(id));
    const reminder = match ? removeReminder(match.id) : null;
    if (reminder) return `Canceled reminder: "${reminder.text}".`;
    return `ERROR: no reminder or routine with id "${id}". Use list_schedules to see current ids.`;
  },
};

export const SCHEDULE_TOOLS: Tool[] = [scheduleRoutineTool, listSchedulesTool, cancelScheduleTool];
