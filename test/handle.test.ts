import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/agent/runner.js", () => ({
  runTurn: vi.fn().mockResolvedValue({ replyText: "ok", silent: false }),
}));

import fs from "node:fs";
import path from "node:path";
import { runTurn } from "../src/agent/runner.js";
import { createInboundHandler, formatForModel } from "../src/handle.js";
import { resetConfigCache } from "../src/config.js";
import { drainLocks } from "../src/util/lock.js";
import { tmpState, cleanup } from "./helpers.js";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
function msg(over: Record<string, unknown> = {}): any {
  return {
    id: "m" + Math.random(),
    chatId: "c@s",
    senderId: "34600@s.whatsapp.net",
    chatType: "direct",
    text: "hi",
    reply: vi.fn().mockResolvedValue({ messageId: "x" }),
    ...over,
  };
}

// tmpState() gives an isolated state dir, clears CRABLITE_* env and resets the
// config cache — without it these tests would merge the developer's real
// ~/.crablite/config.json into loadConfig (a local debounceMs would flake them).
let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = tmpState();
});
afterEach(() => {
  cleanup(dir);
  vi.useRealTimers();
});

describe("inbound handler admission", () => {
  it("ignores everyone when the allowlist is empty (fail-closed)", async () => {
    const h = createInboundHandler("whatsapp").onInbound;
    await h(msg());
    await wait();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("admits an allowlisted sender and delivers the reply", async () => {
    process.env.CRABLITE_ALLOW_FROM = "34600";
    resetConfigCache();
    const h = createInboundHandler("whatsapp").onInbound;
    const m = msg();
    await h(m);
    await wait();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(m.reply).toHaveBeenCalledWith("ok");
  });

  it("dedupes repeated message ids", async () => {
    process.env.CRABLITE_ALLOW_FROM = "*";
    resetConfigCache();
    const h = createInboundHandler("whatsapp").onInbound;
    const m = msg({ id: "same" });
    await h(m);
    await h({ ...m });
    await wait();
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("marks admitted messages as read, and only those", async () => {
    process.env.CRABLITE_ALLOW_FROM = "34600";
    resetConfigCache();
    const h = createInboundHandler("whatsapp").onInbound;
    const admitted = msg({ markRead: vi.fn().mockResolvedValue(undefined) });
    const rejected = msg({
      senderId: "unknown@s",
      markRead: vi.fn().mockResolvedValue(undefined),
    });
    await h(admitted);
    await h(rejected);
    await wait();
    expect(admitted.markRead).toHaveBeenCalledTimes(1);
    expect(rejected.markRead).not.toHaveBeenCalled();
  });

  it("shows typing while the turn runs and clears it afterwards", async () => {
    process.env.CRABLITE_ALLOW_FROM = "*";
    resetConfigCache();
    const typing: boolean[] = [];
    const h = createInboundHandler("whatsapp").onInbound;
    const m = msg({ setTyping: vi.fn(async (on: boolean) => void typing.push(on)) });
    await h(m);
    await wait();
    expect(typing[0]).toBe(true); // composing before the reply
    expect(typing[typing.length - 1]).toBe(false); // cleared after
    expect(m.reply).toHaveBeenCalledWith("ok"); // reply still delivered
  });

  it("formats sender names (groups) and quoted excerpts for the model", () => {
    expect(formatForModel(msg({ text: "hola" }))).toBe("hola");
    expect(formatForModel(msg({ chatType: "group", senderName: "Laura", text: "hola" }))).toBe(
      "[Laura]: hola",
    );
    // Direct chats don't prefix the name (single counterpart).
    expect(formatForModel(msg({ senderName: "Marc", text: "hola" }))).toBe("hola");
    expect(formatForModel(msg({ quotedText: "move it to Friday", text: "ok with this?" }))).toBe(
      '[replying to "move it to Friday"] ok with this?',
    );
    expect(
      formatForModel(
        msg({ chatType: "group", senderName: "Laura", quotedText: "[image]", text: "love it" }),
      ),
    ).toBe('[Laura, replying to "[image]"]: love it');
  });

  it("passes the formatted batch and the sender name to runTurn", async () => {
    process.env.CRABLITE_ALLOW_FROM = "*";
    resetConfigCache();
    const h = createInboundHandler("whatsapp").onInbound;
    await h(
      msg({
        chatType: "group",
        senderName: "Laura",
        text: "hey Crab can you check this",
        quotedText: "budget draft v2",
      }),
    );
    await wait();
    expect(runTurn).toHaveBeenCalledTimes(1);
    const params = vi.mocked(runTurn).mock.calls[0]![0] as any;
    expect(params.userText).toBe(
      '[Laura, replying to "budget draft v2"]: hey Crab can you check this',
    );
    expect(params.senderName).toBe("Laura");
  });

  it("requires a mention in group chats", async () => {
    process.env.CRABLITE_ALLOW_FROM = "*";
    resetConfigCache();
    const h = createInboundHandler("whatsapp").onInbound;
    await h(msg({ chatType: "group", text: "hello everyone" }));
    await wait();
    expect(runTurn).not.toHaveBeenCalled();
    await h(msg({ chatType: "group", text: "hey Crab can you help" }));
    await wait();
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});

describe("flushPending (graceful shutdown)", () => {
  it("forces a debounce-pending batch into the lock queue without waiting out the timer", async () => {
    // A debounce far longer than the test: only flushPending can run the batch.
    process.env.CRABLITE_ALLOW_FROM = "*";
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ debounceMs: 60_000 }));
    resetConfigCache();
    vi.useFakeTimers();

    const handler = createInboundHandler("whatsapp");
    const m = msg({ text: "last words before shutdown" });
    await handler.onInbound(m);
    expect(runTurn).not.toHaveBeenCalled(); // still debounced
    expect(vi.getTimerCount()).toBe(1); // the pending debounce timer

    handler.flushPending();
    expect(vi.getTimerCount()).toBe(0); // timer cleared, batch handed to withLock

    // Shutdown then awaits the queued turn like any other locked work.
    await expect(drainLocks(2_000)).resolves.toBe(true);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTurn).mock.calls[0]![0]).toMatchObject({
      userText: "last words before shutdown",
      chatId: "c@s",
    });
    expect(m.reply).toHaveBeenCalledWith("ok");
  });

  it("is a no-op when nothing is pending", async () => {
    const handler = createInboundHandler("whatsapp");
    handler.flushPending();
    await expect(drainLocks(500)).resolves.toBe(true);
    expect(runTurn).not.toHaveBeenCalled();
  });
});
