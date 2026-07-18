import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../src/codex/responses.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex/responses.js")>();
  return { ...actual, callModel: vi.fn() };
});

import fs from "node:fs";
import path from "node:path";
import { callModel } from "../src/codex/responses.js";
import { tmpState, cleanup } from "./helpers.js";
import { runTurn } from "../src/agent/runner.js";
import { loadSession, appendItems } from "../src/session/store.js";
import { withLock, drainLocks } from "../src/util/lock.js";
import { paths } from "../src/paths.js";

let dir: string;
afterEach(() => {
  cleanup(dir);
  vi.mocked(callModel).mockReset();
});
const reply = async () => {};

describe("runTurn", () => {
  it("runs a text turn, persists the session, returns the reply", async () => {
    dir = tmpState();
    vi.mocked(callModel).mockResolvedValue({ text: "Hi there", toolCalls: [] });
    const res = await runTurn({
      sessionKey: "k",
      userText: "hello",
      channel: "cli",
      chatType: "direct",
      chatReply: reply,
    });
    expect(res.silent).toBe(false);
    expect(res.replyText).toBe("Hi there");
    expect(loadSession("k").items.length).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it("sends the current user message to the model exactly once", async () => {
    dir = tmpState();
    let capturedInput: any[] = [];
    vi.mocked(callModel).mockImplementation(async (p) => {
      capturedInput = [...p.input];
      return { text: "ok", toolCalls: [] };
    });
    await runTurn({
      sessionKey: "k",
      userText: "hello",
      channel: "cli",
      chatType: "direct",
      chatReply: reply,
    });
    // A fresh session's model input must be the single user turn — not a duplicate
    // caused by prior aliasing session.items and being mutated by appendItems.
    expect(capturedInput.length).toBe(1);
    expect(capturedInput.filter((i) => JSON.stringify(i).includes("hello")).length).toBe(1);
  });

  it("saves an inbound document to inbox/ and tells the model where it is", async () => {
    dir = tmpState();
    let capturedInput: any[] = [];
    vi.mocked(callModel).mockImplementation(async (p) => {
      capturedInput = [...p.input];
      return { text: "got it", toolCalls: [] };
    });
    await runTurn({
      sessionKey: "k",
      userText: "here is the invoice",
      media: [
        {
          kind: "document",
          data: Buffer.from("%PDF-fake"),
          mimetype: "application/pdf",
          filename: "factura.pdf",
        },
      ],
      channel: "whatsapp",
      chatType: "direct",
      chatReply: reply,
    });

    const liveText = JSON.stringify(capturedInput.at(-1));
    expect(liveText).toContain("[document saved: inbox/");
    expect(liveText).toContain("factura.pdf");

    const inbox = path.join(paths.workspace(), "inbox");
    const saved = fs.readdirSync(inbox);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/factura\.pdf$/);
    // The persisted transcript carries the note too (searchable later).
    const persisted = JSON.stringify(loadSession("k").items[0]);
    expect(persisted).toContain("[document saved: inbox/");
  });

  it("treats NO_REPLY as silent", async () => {
    dir = tmpState();
    vi.mocked(callModel).mockResolvedValue({ text: "NO_REPLY", toolCalls: [] });
    const res = await runTurn({
      sessionKey: "k",
      userText: "hey",
      channel: "cli",
      chatType: "direct",
      chatReply: reply,
    });
    expect(res.silent).toBe(true);
  });

  it("handles /help and /reset without calling the model", async () => {
    dir = tmpState();
    const help = await runTurn({
      sessionKey: "k",
      userText: "/help",
      channel: "cli",
      chatType: "direct",
      chatReply: reply,
    });
    expect(help.replyText).toMatch(/Commands/);
    expect(callModel).not.toHaveBeenCalled();
    const reset = await runTurn({
      sessionKey: "k",
      userText: "/reset",
      channel: "cli",
      chatType: "direct",
      chatReply: reply,
    });
    expect(reset.replyText).toMatch(/fresh conversation/);
  });

  it("accepts an inbound image (vision) with no transcription call", async () => {
    dir = tmpState();
    vi.mocked(callModel).mockResolvedValue({ text: "nice pic", toolCalls: [] });
    const res = await runTurn({
      sessionKey: "k",
      userText: "look",
      channel: "whatsapp",
      chatType: "direct",
      chatId: "c",
      media: [{ kind: "image", data: Buffer.from("img"), mimetype: "image/png" }],
      chatReply: reply,
    });
    expect(res.replyText).toBe("nice pic");
    expect(JSON.stringify(loadSession("k").items)).toContain("[image]");
  });
});

// --- memory flush scheduling (deferred off the reply path) -------------------

/** Seed the transcript past FLUSH_TRIGGER_CHARS (90k) but under the prune
 * budget (120k), so a turn schedules a flush and pruneForContext returns the
 * session's own items array (the aliasing case the snapshot copy must survive). */
function seedOverFlushThreshold(sessionKey: string): void {
  const session = loadSession(sessionKey);
  const items = Array.from({ length: 11 }, (_, i) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `seed-${i} ${"x".repeat(9_000)}` }],
  }));
  appendItems(session, items);
}

/** The flush turn is recognizable by its fixed instructions (memory/flush.ts). */
const isFlushCall = (p: { instructions: string }) =>
  p.instructions.includes("compacting a conversation");

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("runTurn memory flush scheduling", () => {
  it("with a chatId, the turn resolves before the deferred flush's model call fires", async () => {
    dir = tmpState();
    seedOverFlushThreshold("k");
    const calls: string[] = [];
    vi.mocked(callModel).mockImplementation(async (p) => {
      if (isFlushCall(p)) {
        calls.push("flush");
        return { text: "NONE", toolCalls: [] };
      }
      calls.push("turn");
      return { text: "ok", toolCalls: [] };
    });
    // Run inside withLock(chatId) exactly like handle.ts/heartbeat.ts do —
    // that lock is what orders the deferred flush after this turn.
    const res = await withLock("chat-11", () =>
      runTurn({
        sessionKey: "k",
        userText: "hello",
        channel: "whatsapp",
        chatType: "direct",
        chatId: "chat-11",
        chatReply: reply,
      }),
    );
    // The reply is ready but the flush has not run: it is queued behind the
    // turn on the per-chat lock, off the reply's critical path.
    expect(res.replyText).toBe("ok");
    expect(calls).toEqual(["turn"]);
    await expect(drainLocks(2_000)).resolves.toBe(true);
    expect(calls).toEqual(["turn", "flush"]);
  });

  it("serializes the deferred flush before the next queued turn for the same chat", async () => {
    dir = tmpState();
    seedOverFlushThreshold("k");
    const calls: string[] = [];
    const gate = deferred<{ text: string; toolCalls: never[] }>();
    let firstTurnCall = true;
    vi.mocked(callModel).mockImplementation((p) => {
      if (isFlushCall(p)) {
        calls.push("flush");
        return Promise.resolve({ text: "NONE", toolCalls: [] });
      }
      // Identify the turn by its live user item (the last input item).
      const live = JSON.stringify(p.input[p.input.length - 1]);
      calls.push(live.includes("turn-two") ? "turn-two" : "turn-one");
      if (firstTurnCall) {
        firstTurnCall = false;
        return gate.promise; // hold turn 1 open while turn 2 gets queued
      }
      return Promise.resolve({ text: "ok", toolCalls: [] });
    });
    const turnParams = {
      sessionKey: "k",
      channel: "whatsapp",
      chatType: "direct" as const,
      chatId: "chat-12",
      chatReply: reply,
    };
    const p1 = withLock("chat-12", () => runTurn({ ...turnParams, userText: "turn-one" }));
    // Once turn 1's model call is in flight, its flush is already scheduled.
    await vi.waitFor(() => expect(calls).toContain("turn-one"));
    const p2 = withLock("chat-12", () => runTurn({ ...turnParams, userText: "turn-two" }));
    gate.resolve({ text: "first reply", toolCalls: [] });
    await Promise.all([p1, p2]);
    await expect(drainLocks(2_000)).resolves.toBe(true);
    // The flush completed between the two turns — and ran exactly once
    // (turn 2 must not schedule a duplicate: flushedChars was recorded at
    // scheduling time and the transcript barely grew since).
    expect(calls).toEqual(["turn-one", "flush", "turn-two"]);
  });

  it("snapshots the flush input at scheduling time — the turn's new items never leak in", async () => {
    dir = tmpState();
    seedOverFlushThreshold("k");
    let flushInput: unknown[] | undefined;
    vi.mocked(callModel).mockImplementation(async (p) => {
      if (isFlushCall(p)) {
        flushInput = [...p.input];
        return { text: "NONE", toolCalls: [] };
      }
      return { text: "assistant-reply-marker", toolCalls: [] };
    });
    await withLock("chat-13", () =>
      runTurn({
        sessionKey: "k",
        userText: "fresh-user-marker",
        channel: "whatsapp",
        chatType: "direct",
        chatId: "chat-13",
        chatReply: reply,
      }),
    );
    await expect(drainLocks(2_000)).resolves.toBe(true);
    expect(flushInput).toBeDefined();
    const s = JSON.stringify(flushInput);
    expect(s).toContain("seed-0"); // the pre-turn transcript is all there
    // The flush ran after this turn appended its items to the (shared, cached)
    // session array — a missing copy would leak both markers into the input.
    expect(s).not.toContain("fresh-user-marker");
    expect(s).not.toContain("assistant-reply-marker");
  });

  it("records flushedChars at scheduling so a queued flush is never duplicated", async () => {
    dir = tmpState();
    seedOverFlushThreshold("k");
    let flushCalls = 0;
    const flushGate = deferred<{ text: string; toolCalls: never[] }>();
    vi.mocked(callModel).mockImplementation((p) => {
      if (isFlushCall(p)) {
        flushCalls += 1;
        return flushGate.promise; // keep the first flush pending
      }
      return Promise.resolve({ text: "ok", toolCalls: [] });
    });
    const turnParams = {
      sessionKey: "k",
      channel: "whatsapp",
      chatType: "direct" as const,
      chatId: "chat-14",
      chatReply: reply,
    };
    await withLock("chat-14", () => runTurn({ ...turnParams, userText: "turn-one" }));
    // Second over-threshold turn while the first flush is still queued/pending.
    const p2 = withLock("chat-14", () => runTurn({ ...turnParams, userText: "turn-two" }));
    flushGate.resolve({ text: "NONE", toolCalls: [] });
    await p2;
    await expect(drainLocks(2_000)).resolves.toBe(true);
    expect(flushCalls).toBe(1);
  });

  it("without a chatId, awaits the flush inline before the turn's model call", async () => {
    dir = tmpState();
    seedOverFlushThreshold("k");
    const calls: string[] = [];
    vi.mocked(callModel).mockImplementation(async (p) => {
      if (isFlushCall(p)) {
        calls.push("flush");
        return { text: "NONE", toolCalls: [] };
      }
      calls.push("turn");
      return { text: "ok", toolCalls: [] };
    });
    // CLI path: no chatId, no per-chat lock to serialize a deferred flush on.
    const res = await runTurn({
      sessionKey: "k",
      userText: "hello",
      channel: "cli",
      chatType: "direct",
      chatReply: reply,
    });
    expect(res.replyText).toBe("ok");
    expect(calls).toEqual(["flush", "turn"]);
  });

  it("a failing deferred flush is non-fatal to the turn", async () => {
    dir = tmpState();
    seedOverFlushThreshold("k");
    vi.mocked(callModel).mockImplementation(async (p) => {
      if (isFlushCall(p)) throw new Error("flush transport down");
      return { text: "still fine", toolCalls: [] };
    });
    const res = await withLock("chat-16", () =>
      runTurn({
        sessionKey: "k",
        userText: "hello",
        channel: "whatsapp",
        chatType: "direct",
        chatId: "chat-16",
        chatReply: reply,
      }),
    );
    expect(res.replyText).toBe("still fine");
    // The rejected flush must not wedge the per-chat lock queue either.
    await expect(drainLocks(2_000)).resolves.toBe(true);
  });

  it("a failing inline flush (no chatId) is non-fatal to the turn", async () => {
    dir = tmpState();
    seedOverFlushThreshold("k");
    vi.mocked(callModel).mockImplementation(async (p) => {
      if (isFlushCall(p)) throw new Error("flush transport down");
      return { text: "still fine", toolCalls: [] };
    });
    const res = await runTurn({
      sessionKey: "k",
      userText: "hello",
      channel: "cli",
      chatType: "direct",
      chatReply: reply,
    });
    expect(res.replyText).toBe("still fine");
  });
});
