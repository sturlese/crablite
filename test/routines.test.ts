import { describe, it, expect, afterEach } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs } from "../src/paths.js";
import {
  addRoutine,
  advanceRoutine,
  allRoutines,
  computeNextRun,
  dueRoutines,
  describeSchedule,
  parseAt,
  removeRoutine,
  MIN_EVERY_MINUTES,
} from "../src/agent/routines.js";

let dir: string;
afterEach(() => cleanup(dir));

// Local-time anchor: a fixed date built with the local Date constructor, so
// assertions are timezone-independent.
const at = (h: number, m: number) => new Date(2026, 6, 14, h, m).getTime(); // 2026-07-14

describe("computeNextRun", () => {
  it("daily: later today when the time hasn't passed, else tomorrow", () => {
    const from = at(7, 30);
    const next = new Date(computeNextRun({ kind: "daily", at: "08:00" }, from));
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([14, 8, 0]);

    const tomorrow = new Date(computeNextRun({ kind: "daily", at: "07:00" }, from));
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([15, 7]);
  });

  it("daily: exactly-now schedules the NEXT occurrence (strictly after)", () => {
    const from = at(8, 0);
    const next = new Date(computeNextRun({ kind: "daily", at: "08:00" }, from));
    expect(next.getDate()).toBe(15);
  });

  it("weekly: same weekday later today, else next week; other weekdays roll forward", () => {
    const from = at(7, 30);
    const todayWd = new Date(from).getDay();

    const later = new Date(computeNextRun({ kind: "weekly", weekday: todayWd, at: "09:00" }, from));
    expect([later.getDate(), later.getHours()]).toEqual([14, 9]);

    const nextWeek = new Date(
      computeNextRun({ kind: "weekly", weekday: todayWd, at: "06:00" }, from),
    );
    expect([nextWeek.getDate(), nextWeek.getHours()]).toEqual([21, 6]);

    const tomorrowWd = (todayWd + 1) % 7;
    const tomorrow = new Date(
      computeNextRun({ kind: "weekly", weekday: tomorrowWd, at: "06:00" }, from),
    );
    expect([tomorrow.getDate(), tomorrow.getDay()]).toEqual([15, tomorrowWd]);
  });

  it("every: interval from now, clamped to the minimum", () => {
    const from = at(12, 0);
    expect(computeNextRun({ kind: "every", minutes: 30 }, from)).toBe(from + 30 * 60_000);
    expect(computeNextRun({ kind: "every", minutes: 1 }, from)).toBe(
      from + MIN_EVERY_MINUTES * 60_000,
    );
  });

  it("throws on a malformed time", () => {
    expect(() => computeNextRun({ kind: "daily", at: "morning" }, at(7, 0))).toThrow(/HH:MM/);
  });
});

describe("parseAt", () => {
  it("accepts 24h HH:MM and rejects out-of-range or malformed values", () => {
    expect(parseAt("8:05")).toEqual({ hour: 8, minute: 5 });
    expect(parseAt("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseAt("24:00")).toBeNull();
    expect(parseAt("12:60")).toBeNull();
    expect(parseAt("8:5")).toBeNull();
    expect(parseAt("morning")).toBeNull();
  });
});

describe("describeSchedule", () => {
  it("renders human-readable schedules", () => {
    expect(describeSchedule({ kind: "daily", at: "08:00" })).toBe("daily at 08:00");
    expect(describeSchedule({ kind: "weekly", weekday: 1, at: "09:00" })).toBe(
      "every Monday at 09:00",
    );
    expect(describeSchedule({ kind: "every", minutes: 240 })).toBe("every 240 minutes");
  });
});

describe("routine store", () => {
  it("adds, lists, becomes due, advances without backlog, and removes", () => {
    dir = tmpState();
    ensureStateDirs();

    const r = addRoutine({
      text: "morning briefing",
      schedule: { kind: "every", minutes: 10 },
      chatId: "c@s",
      chatType: "direct",
    });
    expect(r.id).toHaveLength(8);
    expect(r.nextRunAt).toBeGreaterThan(Date.now());
    expect(allRoutines()).toHaveLength(1);

    // Not due yet; due once its time arrives.
    expect(dueRoutines()).toHaveLength(0);
    expect(dueRoutines(r.nextRunAt + 1)).toHaveLength(1);

    // Advance reschedules from "now" (no backlog of missed occurrences).
    advanceRoutine(r.id);
    const advanced = allRoutines()[0]!;
    expect(advanced.lastRunAt).toBeDefined();
    expect(advanced.nextRunAt).toBeGreaterThan(Date.now() + 9 * 60_000);

    expect(removeRoutine(r.id)?.text).toBe("morning briefing");
    expect(removeRoutine(r.id)).toBeNull();
    expect(allRoutines()).toHaveLength(0);
  });
});
