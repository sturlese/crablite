import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../src/codex/responses.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex/responses.js")>();
  return { ...actual, callModel: vi.fn() };
});

import fs from "node:fs";
import { callModel } from "../src/codex/responses.js";
import { tmpState, cleanup } from "./helpers.js";
import { seedWorkspace, dailyNotePath } from "../src/memory/workspace.js";
import { runMemoryFlush } from "../src/memory/flush.js";

let dir: string;
afterEach(() => {
  cleanup(dir);
  vi.mocked(callModel).mockReset();
});

const oneItem = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];

describe("memory flush", () => {
  it("appends durable bullets to today's daily note", async () => {
    dir = tmpState();
    seedWorkspace();
    vi.mocked(callModel).mockResolvedValue({
      text: "- The user likes short emails.",
      toolCalls: [],
    });
    await runMemoryFlush("m", oneItem);
    const note = fs.readFileSync(dailyNotePath(), "utf8");
    expect(note).toContain("short emails");
    expect(note).toContain("Flushed from conversation");
  });

  it("writes nothing when the model returns NONE", async () => {
    dir = tmpState();
    seedWorkspace();
    vi.mocked(callModel).mockResolvedValue({ text: "NONE", toolCalls: [] });
    await runMemoryFlush("m", oneItem);
    expect(fs.existsSync(dailyNotePath())).toBe(false);
  });

  it("swallows model errors without throwing", async () => {
    dir = tmpState();
    seedWorkspace();
    vi.mocked(callModel).mockRejectedValue(new Error("nope"));
    await expect(runMemoryFlush("m", oneItem)).resolves.toBeUndefined();
  });
});
