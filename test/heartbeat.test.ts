import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs } from "../src/paths.js";
import { addReminder } from "../src/agent/reminders.js";

// A reminder turn that takes longer than the 60s heartbeat interval, so a
// second tick fires while the first is still mid-delivery.
vi.mock("../src/agent/runner.js", () => ({
  runTurn: vi.fn(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ silent: false, replyText: "ping" }), 200_000);
      }),
  ),
}));

import { startHeartbeat } from "../src/heartbeat.js";

let dir: string;
afterEach(() => {
  cleanup(dir);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("heartbeat", () => {
  it("delivers each due reminder once even when ticks overlap a slow turn", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    // Two reminders due now, in distinct chats (distinct lock keys → concurrent).
    addReminder({ text: "one", dueAt: Date.now() - 1000, chatId: "a@s", chatType: "direct" });
    addReminder({ text: "two", dueAt: Date.now() - 1000, chatId: "b@s", chatType: "direct" });

    const sends: string[] = [];
    const send = async (chatId: string) => {
      sends.push(chatId);
    };
    startHeartbeat(send);

    await vi.advanceTimersByTimeAsync(10_000); // tick #1: marks r1, awaits its slow turn
    await vi.advanceTimersByTimeAsync(60_000); // tick #2 fires while #1 is still delivering
    await vi.advanceTimersByTimeAsync(1_000_000); // drain all pending turns

    // Without the re-entry guard, tick #2 grabs r2 from the store and delivers
    // it, then tick #1's stale snapshot delivers r2 a second time.
    expect(sends.filter((c) => c === "b@s")).toHaveLength(1);
    expect(sends.filter((c) => c === "a@s")).toHaveLength(1);
  });
});
