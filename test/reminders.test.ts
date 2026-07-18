import fs from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs, paths } from "../src/paths.js";
import {
  addReminder,
  dueReminders,
  pendingReminders,
  markDelivered,
  claimReminder,
  sweepAbandoned,
  CLAIM_STALE_MS,
  MAX_DELIVERY_ATTEMPTS,
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
    const future = addReminder({
      text: "future",
      dueAt: Date.now() + 60_000,
      chatId: "c@s",
      chatType: "direct",
    });
    const due = dueReminders();
    expect(due).toHaveLength(1);
    expect(due[0]!.text).toBe("past");
    for (const r of due) markDelivered(r.id);
    expect(dueReminders()).toHaveLength(0);
    expect(pendingReminders()).toHaveLength(1);
    expect(pendingReminders()[0]!.id).toBe(future.id);
  });

  it("schedule_reminder tool accepts inMinutes and ISO", async () => {
    dir = tmpState();
    ensureStateDirs();
    expect(await scheduleReminderTool.execute({ text: "ping", inMinutes: 30 }, ctx())).toMatch(
      /Reminder set/,
    );
    expect(
      await scheduleReminderTool.execute({ text: "iso", at: "2099-01-01T09:00:00" }, ctx()),
    ).toMatch(/Reminder set/);
    expect(pendingReminders()).toHaveLength(2);
  });

  it("schedule_reminder rejects a bad date, missing chat, and empty text", async () => {
    dir = tmpState();
    ensureStateDirs();
    expect(await scheduleReminderTool.execute({ text: "x", at: "not-a-date" }, ctx())).toMatch(
      /could not parse/,
    );
    expect(
      await scheduleReminderTool.execute({ text: "x", inMinutes: 5 }, ctx({ chatId: undefined })),
    ).toMatch(/outside a chat/);
    expect(await scheduleReminderTool.execute({ text: "" }, ctx())).toMatch(/empty/);
  });

  it("schedule_reminder rejects a non-numeric inMinutes instead of silently never firing", async () => {
    dir = tmpState();
    ensureStateDirs();
    // The model can emit a string for inMinutes (args are raw JSON, not coerced).
    // Number("abc") is NaN and Math.max(1, NaN) is NaN, which used to produce a
    // dueAt=NaN reminder: reported as "set" but never returned by dueReminders().
    expect(await scheduleReminderTool.execute({ text: "x", inMinutes: "abc" }, ctx())).toMatch(
      /could not parse/,
    );
    // Nothing un-fireable should have been persisted.
    expect(pendingReminders()).toHaveLength(0);
    // A numeric string is still accepted (tolerant of stringified numbers).
    expect(await scheduleReminderTool.execute({ text: "y", inMinutes: "15" }, ctx())).toMatch(
      /Reminder set/,
    );
    expect(dueReminders(Date.now() + 20 * 60_000)).toHaveLength(1);
  });
});

describe("at-least-once claims", () => {
  it("a fresh claim hides the reminder from dueReminders until exactly CLAIM_STALE_MS", () => {
    dir = tmpState();
    ensureStateDirs();
    const t0 = Date.now();
    const r = addReminder({ text: "call", dueAt: t0 - 1000, chatId: "c@s", chatType: "direct" });
    expect(dueReminders(t0)).toHaveLength(1);

    claimReminder(r.id, t0);
    expect(dueReminders(t0)).toHaveLength(0); // criterion 3: no same-process re-pick
    expect(dueReminders(t0 + CLAIM_STALE_MS - 1)).toHaveLength(0); // still inside the window
    expect(dueReminders(t0 + CLAIM_STALE_MS)).toHaveLength(1); // boundary is >=: re-admitted
  });

  it("a stale claim seeded on disk (crash mid-delivery) is due again", () => {
    dir = tmpState();
    ensureStateDirs();
    const now = Date.now();
    // What a killed process leaves behind: claimed, one attempt, never confirmed.
    fs.writeFileSync(
      paths.remindersFile(),
      JSON.stringify({
        version: 1,
        reminders: [
          {
            id: "crashed",
            text: "promise at risk",
            dueAt: now - 60_000,
            chatId: "c@s",
            chatType: "direct",
            createdAt: now - 120_000,
            deliveringAt: now - CLAIM_STALE_MS,
            attempts: 1,
          },
        ],
      }),
    );
    expect(dueReminders(now).map((r) => r.id)).toEqual(["crashed"]);
    expect(pendingReminders().map((r) => r.id)).toEqual(["crashed"]);
  });

  it("stops retrying after MAX_DELIVERY_ATTEMPTS but keeps the reminder pending", () => {
    dir = tmpState();
    ensureStateDirs();
    const t0 = Date.now();
    const r = addReminder({ text: "doomed", dueAt: t0 - 1000, chatId: "c@s", chatType: "direct" });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      claimReminder(r.id, t0 + i * CLAIM_STALE_MS);
    }
    // Long after every claim has gone stale: out of attempts, never due again…
    expect(dueReminders(t0 + 10 * CLAIM_STALE_MS)).toHaveLength(0);
    // …but doctor/list_schedules still surface the unkept promise.
    expect(pendingReminders().map((x) => x.id)).toEqual([r.id]);
  });

  it("loads a version-1 record without the new fields unchanged", () => {
    dir = tmpState();
    ensureStateDirs();
    const now = Date.now();
    fs.writeFileSync(
      paths.remindersFile(),
      JSON.stringify({
        version: 1,
        reminders: [
          {
            id: "v1",
            text: "old-format",
            dueAt: now - 1000,
            chatId: "c@s",
            chatType: "direct",
            createdAt: now - 5000,
          },
        ],
      }),
    );
    expect(dueReminders(now)).toHaveLength(1); // due exactly as before
    expect(pendingReminders()).toHaveLength(1); // pending exactly as before
    const claimed = claimReminder("v1", now);
    expect(claimed?.attempts).toBe(1); // additive fields start from absent
    expect(claimed?.deliveringAt).toBe(now);
  });

  it("claimReminder on an unknown id returns null and writes nothing", () => {
    dir = tmpState();
    ensureStateDirs();
    expect(claimReminder("no-such-id")).toBeNull();
    expect(fs.existsSync(paths.remindersFile())).toBe(false); // no store created
  });

  it("sweepAbandoned stamps exhausted reminders exactly once (idempotent)", () => {
    dir = tmpState();
    ensureStateDirs();
    const t0 = Date.now();
    const r = addReminder({
      text: "worn out",
      dueAt: t0 - 1000,
      chatId: "c@s",
      chatType: "direct",
    });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) claimReminder(r.id, t0 + i);

    const first = sweepAbandoned(t0 + 1000);
    expect(first.map((x) => x.id)).toEqual([r.id]); // newly stamped, reported once
    expect(first[0]!.abandonedAt).toBe(t0 + 1000);
    expect(sweepAbandoned(t0 + 2000)).toEqual([]); // second sweep: nothing new

    expect(dueReminders(t0 + 10 * CLAIM_STALE_MS)).toHaveLength(0); // terminal: never due again
    expect(pendingReminders().map((x) => x.id)).toEqual([r.id]); // but still listed

    // A delivered reminder is never swept, even with exhausted attempts.
    const ok = addReminder({ text: "fine", dueAt: t0 - 1000, chatId: "c@s", chatType: "direct" });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) claimReminder(ok.id, t0 + i);
    markDelivered(ok.id);
    expect(sweepAbandoned(t0 + 3000)).toEqual([]);
  });
});
