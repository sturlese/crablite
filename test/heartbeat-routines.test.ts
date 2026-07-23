import fs from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs, paths } from "../src/paths.js";
import { addRoutine, allRoutines } from "../src/agent/routines.js";
import { resetConfigCache } from "../src/config.js";

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
  resetConfigCache(); // the check-in test writes config.json; don't leak it forward
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
    const typing: Array<[string, boolean]> = [];
    startHeartbeat({
      id: "whatsapp",
      send: async (chatId, text) => {
        sends.push([chatId, text]);
      },
      sendTyping: async (chatId, on) => {
        typing.push([chatId, on]);
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
    // Typing shown during the proactive turn and cleared afterwards.
    expect(typing[0]).toEqual(["a@s", true]);
    expect(typing[typing.length - 1]).toEqual(["a@s", false]);

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

describe("heartbeat daily check-in", () => {
  it("uses the group session/chatType for a group primary chat (no fork)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 9, 0, 0)); // 09:00 local
    dir = tmpState();
    ensureStateDirs();
    // A group jid as the primary chat; the check-in must run under the same
    // session key handle.ts writes for that group, not a forked "direct" one.
    fs.writeFileSync(
      paths.config(),
      JSON.stringify({ heartbeatChat: "team@g.us", heartbeatHour: 9 }),
    );
    resetConfigCache();

    startHeartbeat({ id: "whatsapp", send: async () => {} });

    await vi.advanceTimersByTimeAsync(10_000); // startup tick at 09:00:10 → check-in runs

    expect(runTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runTurn).mock.calls[0]![0] as any;
    expect(call.userText).toContain("[Heartbeat]");
    expect(call.chatType).toBe("group"); // was hardcoded "direct"
    expect(call.sessionKey).toContain(":group:");
    expect(call.sessionKey).toContain("team@g.us");
  });
});
