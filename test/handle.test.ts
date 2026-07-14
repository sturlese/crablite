import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/agent/runner.js", () => ({
  runTurn: vi.fn().mockResolvedValue({ replyText: "ok", silent: false }),
}));

import { runTurn } from "../src/agent/runner.js";
import { createInboundHandler, formatForModel } from "../src/handle.js";
import { resetConfigCache } from "../src/config.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRABLITE_ALLOW_FROM;
  resetConfigCache();
});

describe("inbound handler admission", () => {
  it("ignores everyone when the allowlist is empty (fail-closed)", async () => {
    const h = createInboundHandler("whatsapp");
    await h(msg());
    await wait();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("admits an allowlisted sender and delivers the reply", async () => {
    process.env.CRABLITE_ALLOW_FROM = "34600";
    resetConfigCache();
    const h = createInboundHandler("whatsapp");
    const m = msg();
    await h(m);
    await wait();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(m.reply).toHaveBeenCalledWith("ok");
  });

  it("dedupes repeated message ids", async () => {
    process.env.CRABLITE_ALLOW_FROM = "*";
    resetConfigCache();
    const h = createInboundHandler("whatsapp");
    const m = msg({ id: "same" });
    await h(m);
    await h({ ...m });
    await wait();
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("marks admitted messages as read, and only those", async () => {
    process.env.CRABLITE_ALLOW_FROM = "34600";
    resetConfigCache();
    const h = createInboundHandler("whatsapp");
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
    const h = createInboundHandler("whatsapp");
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
    const h = createInboundHandler("whatsapp");
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
    const h = createInboundHandler("whatsapp");
    await h(msg({ chatType: "group", text: "hello everyone" }));
    await wait();
    expect(runTurn).not.toHaveBeenCalled();
    await h(msg({ chatType: "group", text: "hey Crab can you help" }));
    await wait();
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});
