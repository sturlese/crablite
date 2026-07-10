import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/agent/runner.js", () => ({
  runTurn: vi.fn().mockResolvedValue({ replyText: "ok", silent: false }),
}));

import { runTurn } from "../src/agent/runner.js";
import { createInboundHandler } from "../src/handle.js";
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
