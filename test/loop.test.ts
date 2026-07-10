import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/codex/responses.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex/responses.js")>();
  return { ...actual, callModel: vi.fn() };
});

import { callModel } from "../src/codex/responses.js";
import { runAgentLoop } from "../src/agent/loop.js";

const mocked = () => vi.mocked(callModel);
const baseArgs = { model: "m", instructions: "i", input: [], ctx: { workspaceDir: "/tmp", depth: 0 }, maxRounds: 5, idleTimeoutMs: 1000 };

beforeEach(() => vi.mocked(callModel).mockReset());

describe("runAgentLoop", () => {
  it("returns text when no tools are requested", async () => {
    mocked().mockResolvedValueOnce({ text: "hello", toolCalls: [] });
    const r = await runAgentLoop({ ...baseArgs, tools: [] });
    expect(r.text).toBe("hello");
    expect(r.newItems).toHaveLength(1);
  });

  it("executes a tool call and feeds the result back", async () => {
    const echo = { name: "echo", description: "echo", parameters: {}, execute: vi.fn(async (a: any) => `did:${a.x}`) };
    mocked()
      .mockResolvedValueOnce({ text: "", toolCalls: [{ callId: "c1", name: "echo", arguments: JSON.stringify({ x: "hi" }) }] })
      .mockResolvedValueOnce({ text: "done", toolCalls: [] });
    const r = await runAgentLoop({ ...baseArgs, tools: [echo] });
    expect(echo.execute).toHaveBeenCalled();
    expect(r.text).toBe("done");
    const types = r.newItems.map((i: any) => i.type);
    expect(types).toContain("function_call");
    expect(types).toContain("function_call_output");
  });

  it("reports an unknown tool without throwing", async () => {
    mocked()
      .mockResolvedValueOnce({ text: "", toolCalls: [{ callId: "c1", name: "missing", arguments: "{}" }] })
      .mockResolvedValueOnce({ text: "ok", toolCalls: [] });
    const r = await runAgentLoop({ ...baseArgs, tools: [] });
    const out = r.newItems.find((i: any) => i.type === "function_call_output");
    expect(out.output).toMatch(/unknown tool/);
  });
});
