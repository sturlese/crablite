import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/codex/responses.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex/responses.js")>();
  return { ...actual, callModel: vi.fn() };
});

import { callModel } from "../src/codex/responses.js";
import { makeSpawnTool, buildSubagentPrompt } from "../src/agent/subagent.js";

beforeEach(() => vi.mocked(callModel).mockReset());

describe("subagents", () => {
  it("subagent prompt grants recursive spawning only below max depth", () => {
    expect(buildSubagentPrompt(1, 2)).toContain("SUBAGENT");
    expect(buildSubagentPrompt(1, 2)).toMatch(/spawn your own subagents/);
    expect(buildSubagentPrompt(2, 2)).not.toMatch(/spawn your own subagents/);
  });

  it("spawn tool runs a child and returns its final message", async () => {
    vi.mocked(callModel).mockResolvedValueOnce({ text: "child result", toolCalls: [] });
    const tool = makeSpawnTool({ model: "m", maxDepth: 2, idleTimeoutMs: 1000, maxRounds: 5 });
    expect(await tool.execute({ task: "do it" }, { workspaceDir: "/tmp", depth: 0 })).toBe("child result");
  });

  it("refuses to spawn at the depth limit", async () => {
    const tool = makeSpawnTool({ model: "m", maxDepth: 2, idleTimeoutMs: 1000, maxRounds: 5 });
    expect(await tool.execute({ task: "x" }, { workspaceDir: "/tmp", depth: 2 })).toMatch(/depth limit/);
  });
});
