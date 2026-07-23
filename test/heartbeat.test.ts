import fs from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs, paths } from "../src/paths.js";
import {
  addReminder,
  dueReminders,
  pendingReminders,
  removeReminder,
  CLAIM_STALE_MS,
  type Reminder,
} from "../src/agent/reminders.js";
import { drainLocks } from "../src/util/lock.js";
import { log } from "../src/logger.js";

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
import { runTurn } from "../src/agent/runner.js";

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
    startHeartbeat({ id: "whatsapp", send });

    await vi.advanceTimersByTimeAsync(10_000); // tick #1: marks r1, awaits its slow turn
    await vi.advanceTimersByTimeAsync(60_000); // tick #2 fires while #1 is still delivering
    await vi.advanceTimersByTimeAsync(1_000_000); // drain all pending turns

    // Without the re-entry guard, tick #2 grabs r2 from the store and delivers
    // it, then tick #1's stale snapshot delivers r2 a second time.
    expect(sends.filter((c) => c === "b@s")).toHaveLength(1);
    expect(sends.filter((c) => c === "a@s")).toHaveLength(1);
  });

  it("the stop handle prevents all future ticks (graceful shutdown contract)", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    addReminder({ text: "late", dueAt: Date.now() - 1000, chatId: "a@s", chatType: "direct" });

    const sends: string[] = [];
    const stop = startHeartbeat({
      id: "whatsapp",
      send: async (chatId: string) => {
        sends.push(chatId);
      },
    });
    stop(); // shutdown before the startup tick (10s) or any interval tick fires

    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(sends).toEqual([]);
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
  });
});

// --- at-least-once delivery (claim → deliver → confirm) ----------------------

/** The persisted store is the crash-safety contract — read it raw. */
function readStoredReminders(): Reminder[] {
  return (JSON.parse(fs.readFileSync(paths.remindersFile(), "utf8")) as { reminders: Reminder[] })
    .reminders;
}

describe("heartbeat at-least-once delivery", () => {
  it("never marks delivered when both the rich turn and the plain fallback fail", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    addReminder({ text: "urgent", dueAt: Date.now() - 1000, chatId: "a@s", chatType: "direct" });
    vi.mocked(runTurn).mockRejectedValue(new Error("model down"));
    const send = vi.fn(async () => {
      throw new Error("socket down");
    });
    const stop = startHeartbeat({ id: "whatsapp", send });

    await vi.advanceTimersByTimeAsync(10_000); // startup tick: one failed attempt
    const [stored] = readStoredReminders();
    expect(stored!.delivered).toBeUndefined(); // criterion 1: never confirmed on failure
    expect(stored!.deliveringAt).toBeDefined(); // the claim was persisted before the attempt
    expect(stored!.attempts).toBe(1);
    expect(send).toHaveBeenCalledTimes(1); // the plain fallback was tried

    await vi.advanceTimersByTimeAsync(5 * 60_000); // several ticks inside the stale window
    expect(readStoredReminders()[0]!.attempts).toBe(1); // criterion 3: fresh claim not re-picked
    expect(dueReminders(Date.now())).toHaveLength(0);
    expect(pendingReminders()).toHaveLength(1); // the promise is still on the books
    stop();
  });

  it("retries on stale claims and abandons at error level after the third failed attempt", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    addReminder({ text: "doomed", dueAt: Date.now() - 1000, chatId: "a@s", chatType: "direct" });
    vi.mocked(runTurn).mockRejectedValue(new Error("model down"));
    const send = vi.fn(async () => {
      throw new Error("socket down");
    });
    const errorSpy = vi.spyOn(log, "error");
    const stop = startHeartbeat({ id: "whatsapp", send });

    // Enough ticks for attempt 1 (startup) and two stale-window recoveries.
    await vi.advanceTimersByTimeAsync(3 * CLAIM_STALE_MS + 5 * 60_000);
    expect(readStoredReminders()[0]!.attempts).toBe(3);
    expect(send).toHaveBeenCalledTimes(3); // one plain fallback per attempt
    const abandonments = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes("abandoned after 3 failed delivery attempts"),
    );
    expect(abandonments).toHaveLength(1); // exactly once, on the final attempt

    await vi.advanceTimersByTimeAsync(2 * CLAIM_STALE_MS); // long after: no fourth attempt
    expect(send).toHaveBeenCalledTimes(3);
    expect(readStoredReminders()[0]!.delivered).toBeUndefined();
    errorSpy.mockRestore();
    stop();
  });

  it("confirms via the plain fallback when the rich turn fails", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    addReminder({
      text: "fallback me",
      dueAt: Date.now() - 1000,
      chatId: "a@s",
      chatType: "direct",
    });
    vi.mocked(runTurn).mockRejectedValue(new Error("model down"));
    const sends: string[] = [];
    const send = async (_chatId: string, text: string) => {
      sends.push(text);
    };
    const errorSpy = vi.spyOn(log, "error");
    const stop = startHeartbeat({ id: "whatsapp", send });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toEqual(["⏰ Reminder: fallback me"]);
    expect(readStoredReminders()[0]!.delivered).toBe(true); // fallback success confirms

    await vi.advanceTimersByTimeAsync(2 * CLAIM_STALE_MS); // stale window passes…
    expect(sends).toHaveLength(1); // …no redelivery
    const abandonments = errorSpy.mock.calls.filter((c) => String(c[0]).includes("abandoned"));
    expect(abandonments).toHaveLength(0);
    errorSpy.mockRestore();
    stop();
  });

  it("confirms after a successful rich delivery; later ticks send nothing", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    addReminder({ text: "easy", dueAt: Date.now() - 1000, chatId: "a@s", chatType: "direct" });
    vi.mocked(runTurn).mockResolvedValue({ silent: false, replyText: "here is your reminder" });
    const sends: string[] = [];
    const send = async (_chatId: string, text: string) => {
      sends.push(text);
    };
    const stop = startHeartbeat({ id: "whatsapp", send });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toEqual(["here is your reminder"]);
    const [stored] = readStoredReminders();
    expect(stored!.delivered).toBe(true);
    expect(stored!.attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(2 * CLAIM_STALE_MS); // no duplicate after the window
    expect(sends).toHaveLength(1);
    stop();
  });

  it("sweeps a crash-exhausted zombie: abandonedAt stamped, one id-only error log, no retry", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    const now = Date.now();
    // What a process killed during the FINAL attempt leaves behind: out of
    // retries, no abandonedAt, no in-process abandonment log ever emitted.
    fs.writeFileSync(
      paths.remindersFile(),
      JSON.stringify({
        version: 1,
        reminders: [
          {
            id: "zombie-1",
            text: "top-secret-payload",
            dueAt: now - 60_000,
            chatId: "a@s",
            chatType: "direct",
            createdAt: now - 120_000,
            deliveringAt: now - 2 * CLAIM_STALE_MS,
            attempts: 3,
          },
        ],
      }),
    );
    const errorSpy = vi.spyOn(log, "error");
    const send = vi.fn(async () => {});
    const stop = startHeartbeat({ id: "whatsapp", send });

    await vi.advanceTimersByTimeAsync(10_000); // tick 1: the sweep stamps and logs
    const [stored] = readStoredReminders();
    expect(stored!.abandonedAt).toBeDefined();
    expect(dueReminders(Date.now())).toHaveLength(0); // terminal — no delivery attempt
    expect(pendingReminders().map((r) => r.id)).toEqual(["zombie-1"]); // still visible
    expect(send).not.toHaveBeenCalled();
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
    const abandonments = errorSpy.mock.calls.filter((c) => String(c[0]).includes("abandoned"));
    expect(abandonments).toHaveLength(1);
    expect(String(abandonments[0]![0])).toContain("zombie-1"); // id is in the error line
    expect(String(abandonments[0]![0])).toContain("after 3 failed delivery attempts");
    // R5: the reminder text is user content — it must never reach error level.
    expect(errorSpy.mock.calls.some((c) => c.join(" ").includes("top-secret-payload"))).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000); // tick 2: idempotent sweep, no second log
    expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes("abandoned"))).toHaveLength(1);
    errorSpy.mockRestore();
    stop();
  });

  it("does not deliver a reminder canceled between the due snapshot and the claim", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    const first = addReminder({
      text: "first",
      dueAt: Date.now() - 2000,
      chatId: "a@s",
      chatType: "direct",
    });
    const second = addReminder({
      text: "second",
      dueAt: Date.now() - 1000,
      chatId: "b@s",
      chatType: "direct",
    });
    // Both are in this tick's dueReminders snapshot. While the first delivery
    // turn runs, the user cancels the second (cancel_schedule's store path).
    vi.mocked(runTurn).mockImplementation(async () => {
      removeReminder(second.id);
      return { silent: false, replyText: "done" };
    });
    const sends: string[] = [];
    const send = async (chatId: string, text: string) => {
      sends.push(`${chatId}:${text}`);
    };
    const stop = startHeartbeat({ id: "whatsapp", send });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toEqual(["a@s:done"]); // the canceled reminder was never sent
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1); // and no turn ran for it
    const stored = readStoredReminders();
    expect(stored.map((r) => r.id)).toEqual([first.id]); // no claim write resurrected it
    expect(stored[0]!.delivered).toBe(true);
    stop();
  });

  it("drainLocks resolves only after the delivery confirm is persisted (shutdown duplicate gap)", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    addReminder({
      text: "confirm me",
      dueAt: Date.now() - 1000,
      chatId: "a@s",
      chatType: "direct",
    });
    vi.mocked(runTurn).mockResolvedValue({ silent: false, replyText: "late reply" });
    // The send hangs (slow socket) exactly when a SIGTERM drain would start.
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((r) => {
      releaseSend = r;
    });
    const send = vi.fn(() => sendGate);
    const stop = startHeartbeat({ id: "whatsapp", send });

    await vi.advanceTimersByTimeAsync(10_000); // tick: claim + turn done, send in flight
    expect(send).toHaveBeenCalledTimes(1);
    expect(readStoredReminders()[0]!.delivered).toBeUndefined(); // not confirmed yet

    stop(); // shutdown: schedulers stopped, now the drain
    let drained: boolean | undefined;
    const drain = drainLocks(600_000).then((v) => {
      drained = v;
      return v;
    });
    await vi.advanceTimersByTimeAsync(1);
    // The whole protocol shares one lock scope, so the drain is still waiting:
    // if the lock only covered the turn, the tail would already have settled
    // and the process could exit between the send and its confirm — the exact
    // gap that guarantees a duplicate after restart.
    expect(drained).toBeUndefined();

    releaseSend(); // the send finally lands
    await expect(drain).resolves.toBe(true);
    expect(readStoredReminders()[0]!.delivered).toBe(true); // confirmed BEFORE the drain settled
  });

  it("does not re-send when the confirm store-write fails after a successful send", async () => {
    vi.useFakeTimers();
    dir = tmpState();
    ensureStateDirs();
    addReminder({ text: "pay rent", dueAt: Date.now() - 1000, chatId: "a@s", chatType: "direct" });
    const tmpPath = `${paths.remindersFile()}.tmp`;
    // The rich turn succeeds, then makes the confirm store-write fail — deterministically
    // and independent of user/OS permissions: pre-create writeJsonFileAtomic's temp path
    // as a DIRECTORY so its writeFileSync hits EISDIR (even root can't write a directory).
    // The claim already persisted (before this mock ran) and the send lands, so the
    // confirm error must NOT be mistaken for a delivery failure and re-sent — it must
    // propagate to the caller's loop catch.
    vi.mocked(runTurn).mockImplementation(async () => {
      fs.mkdirSync(tmpPath);
      return { silent: false, replyText: "here is your reminder" };
    });
    const sends: string[] = [];
    const send = async (_chatId: string, text: string) => {
      sends.push(text);
    };
    const errorSpy = vi.spyOn(log, "error");
    const stop = startHeartbeat({ id: "whatsapp", send });

    await vi.advanceTimersByTimeAsync(10_000); // claim ok, turn ok, send ok, confirm throws EISDIR

    // Delivered exactly once, and it was the rich reply — not a duplicate fallback.
    expect(sends).toEqual(["here is your reminder"]);
    // The confirm error propagated (per the docblock); the already-delivered reminder
    // was not falsely abandoned.
    const abandonments = errorSpy.mock.calls.filter((c) => String(c[0]).includes("abandoned"));
    expect(abandonments).toHaveLength(0);
    expect(readStoredReminders()[0]!.abandonedAt).toBeUndefined();

    errorSpy.mockRestore();
    stop();
  });
});
