import { describe, it, expect, afterEach } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs } from "../src/paths.js";
import {
  addReminder,
  dueReminders,
  pendingReminders,
  markDelivered,
  scheduleReminderTool,
} from "../src/agent/reminders.js";

let dir: string;
afterEach(() => cleanup(dir));

const ctx = (extra: Record<string, unknown> = {}) =>
  ({ workspaceDir: "/tmp", depth: 0, chatId: "c@s", chatType: "direct", ...extra }) as any;

describe("reminders", () => {
  it("adds, separates due from future, and marks delivered", () => {
    dir = tmpState();
    ensureStateDirs();
    addReminder({ text: "past", dueAt: Date.now() - 1000, chatId: "c@s", chatType: "direct" });
    const future = addReminder({ text: "future", dueAt: Date.now() + 60_000, chatId: "c@s", chatType: "direct" });
    const due = dueReminders();
    expect(due).toHaveLength(1);
    expect(due[0]!.text).toBe("past");
    due.forEach((r) => markDelivered(r.id));
    expect(dueReminders()).toHaveLength(0);
    expect(pendingReminders()).toHaveLength(1);
    expect(pendingReminders()[0]!.id).toBe(future.id);
  });

  it("schedule_reminder tool accepts inMinutes and ISO", async () => {
    dir = tmpState();
    ensureStateDirs();
    expect(await scheduleReminderTool.execute({ text: "ping", inMinutes: 30 }, ctx())).toMatch(/Reminder set/);
    expect(await scheduleReminderTool.execute({ text: "iso", at: "2099-01-01T09:00:00" }, ctx())).toMatch(/Reminder set/);
    expect(pendingReminders()).toHaveLength(2);
  });

  it("schedule_reminder rejects a bad date, missing chat, and empty text", async () => {
    dir = tmpState();
    ensureStateDirs();
    expect(await scheduleReminderTool.execute({ text: "x", at: "not-a-date" }, ctx())).toMatch(/could not parse/);
    expect(await scheduleReminderTool.execute({ text: "x", inMinutes: 5 }, ctx({ chatId: undefined }))).toMatch(
      /outside a chat/,
    );
    expect(await scheduleReminderTool.execute({ text: "" }, ctx())).toMatch(/empty/);
  });

  it("schedule_reminder rejects a non-numeric inMinutes instead of silently never firing", async () => {
    dir = tmpState();
    ensureStateDirs();
    // The model can emit a string for inMinutes (args are raw JSON, not coerced).
    // Number("abc") is NaN and Math.max(1, NaN) is NaN, which used to produce a
    // dueAt=NaN reminder: reported as "set" but never returned by dueReminders().
    expect(await scheduleReminderTool.execute({ text: "x", inMinutes: "abc" }, ctx())).toMatch(/could not parse/);
    // Nothing un-fireable should have been persisted.
    expect(pendingReminders()).toHaveLength(0);
    // A numeric string is still accepted (tolerant of stringified numbers).
    expect(await scheduleReminderTool.execute({ text: "y", inMinutes: "15" }, ctx())).toMatch(/Reminder set/);
    expect(dueReminders(Date.now() + 20 * 60_000)).toHaveLength(1);
  });
});
