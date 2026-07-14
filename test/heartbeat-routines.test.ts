import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs } from "../src/paths.js";
import { addRoutine, allRoutines } from "../src/agent/routines.js";

// Routine turns resolve fast here; behavior branches on the routine text so a
// single mock covers both the replying and the NO_REPLY (silent) cases.
vi.mock("../src/agent/runner.js", () => ({
  runTurn: vi.fn(async (params: any) =>
    String(params.userText).includes("quiet check")
      ? { silent: true, replyText: "NO_REPLY" }
      : { silent: false, replyText: "routine done" },
  ),
}));

import { runTurn } from "../src/agent/runner.js";
import { startHeartbeat } from "../src/heartbeat.js";

let dir: string;
afterEach(() => {
  cleanup(dir);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("heartbeat routines", () => {
  it("runs a due routine as a proactive turn, delivers, and reschedules", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    const r = addRoutine({
      text: "morning briefing",
      schedule: { kind: "every", minutes: 5 },
      chatId: "a@s",
      chatType: "direct",
    });

    const sends: Array<[string, string]> = [];
    startHeartbeat({
      id: "whatsapp",
      send: async (chatId, text) => {
        sends.push([chatId, text]);
      },
    });

    // Not due yet at the startup check (fires in 5 min).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runTurn).not.toHaveBeenCalled();

    // Cross the 5-minute mark: the next minute tick runs it once.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(runTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runTurn).mock.calls[0]![0] as any;
    expect(call.userText).toContain("[Scheduled routine");
    expect(call.userText).toContain("morning briefing");
    expect(call.chatId).toBe("a@s");
    expect(sends).toEqual([["a@s", "routine done"]]);

    // Rescheduled from "now": one more minute tick must NOT re-fire it.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTurn).toHaveBeenCalledTimes(1);
    const advanced = allRoutines().find((x) => x.id === r.id)!;
    expect(advanced.lastRunAt).toBeDefined();
    expect(advanced.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("respects NO_REPLY: a silent routine sends nothing (unlike reminders)", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    addRoutine({
      text: "quiet check for urgent mail",
      schedule: { kind: "every", minutes: 5 },
      chatId: "b@s",
      chatType: "direct",
    });

    const sends: string[] = [];
    startHeartbeat({
      id: "whatsapp",
      send: async (chatId) => {
        sends.push(chatId);
      },
    });

    await vi.advanceTimersByTimeAsync(10_000 + 6 * 60_000);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(sends).toEqual([]); // silence respected — no fallback send
  });
});
