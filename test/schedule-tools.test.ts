import { describe, it, expect, afterEach } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs } from "../src/paths.js";
import { SCHEDULE_TOOLS } from "../src/agent/schedule-tools.js";
import {
  addReminder,
  claimReminder,
  pendingReminders,
  sweepAbandoned,
  MAX_DELIVERY_ATTEMPTS,
} from "../src/agent/reminders.js";
import { allRoutines } from "../src/agent/routines.js";

let dir: string;
afterEach(() => cleanup(dir));

const tool = (n: string) => SCHEDULE_TOOLS.find((t) => t.name === n)!;
const ctx: any = { workspaceDir: "/tmp/x", depth: 0, chatId: "me@s", chatType: "direct" };

function setup() {
  dir = tmpState();
  ensureStateDirs();
}

describe("schedule_routine", () => {
  it("creates a daily routine bound to the current chat", async () => {
    setup();
    const out = await tool("schedule_routine").execute(
      { text: "morning briefing", kind: "daily", at: "08:00" },
      ctx,
    );
    expect(out).toMatch(/Routine \[[0-9a-f]{8}\] set \(daily at 08:00\)/);
    const r = allRoutines()[0]!;
    expect(r.chatId).toBe("me@s");
    expect(r.schedule).toEqual({ kind: "daily", at: "08:00" });
  });

  it("creates weekly and interval routines (interval clamped to the minimum)", async () => {
    setup();
    const weekly = await tool("schedule_routine").execute(
      { text: "weekly review", kind: "weekly", weekday: "Monday", at: "09:00" },
      ctx,
    );
    expect(weekly).toContain("every Monday at 09:00");
    const every = await tool("schedule_routine").execute(
      { text: "check mail", kind: "every", everyMinutes: 1 },
      ctx,
    );
    expect(every).toContain("every 5 minutes");
  });

  it("validates its flat params and requires a chat", async () => {
    setup();
    const t = tool("schedule_routine");
    expect(await t.execute({ text: "x", kind: "daily", at: "25:00" }, ctx)).toMatch(/ERROR.*HH:MM/);
    expect(
      await t.execute({ text: "x", kind: "weekly", at: "09:00", weekday: "someday" }, ctx),
    ).toMatch(/ERROR.*weekday/);
    expect(await t.execute({ text: "x", kind: "every", everyMinutes: "soon" }, ctx)).toMatch(
      /ERROR.*everyMinutes/,
    );
    expect(await t.execute({ text: "x", kind: "hourly" }, ctx)).toMatch(/ERROR.*kind/);
    expect(await t.execute({ text: "", kind: "daily", at: "08:00" }, ctx)).toMatch(/empty routine/);
    expect(await t.execute({ text: "x", kind: "daily", at: "08:00" }, { depth: 0 })).toMatch(
      /outside a chat/,
    );
  });
});

describe("list_schedules / cancel_schedule", () => {
  it("says so when nothing is scheduled", async () => {
    setup();
    expect(await tool("list_schedules").execute({}, ctx)).toMatch(/Nothing is scheduled/);
  });

  it("lists reminders and routines with ids, labeling other chats", async () => {
    setup();
    addReminder({
      text: "call Ana",
      dueAt: Date.now() + 60_000,
      chatId: "me@s",
      chatType: "direct",
    });
    await tool("schedule_routine").execute(
      { text: "morning briefing", kind: "daily", at: "08:00" },
      ctx,
    );
    await tool("schedule_routine").execute(
      { text: "group digest", kind: "daily", at: "18:00" },
      { ...ctx, chatId: "team@g.us", chatType: "group" },
    );

    const out = await tool("list_schedules").execute({}, ctx);
    expect(out).toContain("Reminders (one-shot):");
    expect(out).toContain('"call Ana"');
    expect(out).toContain("Routines (recurring):");
    expect(out).toContain("daily at 08:00");
    expect(out).toContain("(chat team@g.us)"); // cross-chat item is labeled
    expect(out).not.toContain("(chat me@s)"); // current chat is not
  });

  it("cancels a routine by id and a reminder by its shown 8-char prefix", async () => {
    setup();
    const created = await tool("schedule_routine").execute(
      { text: "check mail", kind: "every", everyMinutes: 30 },
      ctx,
    );
    const routineId = /\[([0-9a-f]{8})\]/.exec(String(created))![1]!;
    const rem = addReminder({
      text: "one-shot",
      dueAt: Date.now() + 60_000,
      chatId: "me@s",
      chatType: "direct",
    });

    expect(await tool("cancel_schedule").execute({ id: routineId }, ctx)).toContain(
      "Canceled routine",
    );
    expect(allRoutines()).toHaveLength(0);

    expect(await tool("cancel_schedule").execute({ id: rem.id.slice(0, 8) }, ctx)).toContain(
      'Canceled reminder: "one-shot"',
    );
    expect(pendingReminders()).toHaveLength(0);

    expect(await tool("cancel_schedule").execute({ id: "deadbeef" }, ctx)).toMatch(
      /ERROR: no reminder/,
    );
  });

  it("labels an abandoned reminder as failed and leaves live ones unlabeled", async () => {
    setup();
    addReminder({
      text: "live one",
      dueAt: Date.now() + 60_000,
      chatId: "me@s",
      chatType: "direct",
    });
    const dead = addReminder({
      text: "dead one",
      dueAt: Date.now() - 60_000,
      chatId: "me@s",
      chatType: "direct",
    });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) claimReminder(dead.id, Date.now());
    sweepAbandoned();

    const out = String(await tool("list_schedules").execute({}, ctx));
    const lines = out.split("\n");
    const deadLine = lines.find((l) => l.includes("dead one"));
    const liveLine = lines.find((l) => l.includes("live one"));
    expect(deadLine).toContain("delivery failed, will not retry"); // annotated, still listed
    expect(liveLine).toBeDefined();
    expect(liveLine).not.toContain("delivery failed"); // live reminders stay clean
  });
});
