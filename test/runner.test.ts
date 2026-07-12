import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../src/codex/responses.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex/responses.js")>();
  return { ...actual, callModel: vi.fn() };
});

import { callModel } from "../src/codex/responses.js";
import { tmpState, cleanup } from "./helpers.js";
import { runTurn } from "../src/agent/runner.js";
import { loadSession } from "../src/session/store.js";

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
    const res = await runTurn({ sessionKey: "k", userText: "hello", channel: "cli", chatType: "direct", chatReply: reply });
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
    await runTurn({ sessionKey: "k", userText: "hello", channel: "cli", chatType: "direct", chatReply: reply });
    // A fresh session's model input must be the single user turn — not a duplicate
    // caused by prior aliasing session.items and being mutated by appendItems.
    expect(capturedInput.length).toBe(1);
    expect(capturedInput.filter((i) => JSON.stringify(i).includes("hello")).length).toBe(1);
  });

  it("treats NO_REPLY as silent", async () => {
    dir = tmpState();
    vi.mocked(callModel).mockResolvedValue({ text: "NO_REPLY", toolCalls: [] });
    const res = await runTurn({ sessionKey: "k", userText: "hey", channel: "cli", chatType: "direct", chatReply: reply });
    expect(res.silent).toBe(true);
  });

  it("handles /help and /reset without calling the model", async () => {
    dir = tmpState();
    const help = await runTurn({ sessionKey: "k", userText: "/help", channel: "cli", chatType: "direct", chatReply: reply });
    expect(help.replyText).toMatch(/Commands/);
    expect(callModel).not.toHaveBeenCalled();
    const reset = await runTurn({ sessionKey: "k", userText: "/reset", channel: "cli", chatType: "direct", chatReply: reply });
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
