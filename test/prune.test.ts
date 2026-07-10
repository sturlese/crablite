import { describe, it, expect } from "vitest";
import { estimateChars, pruneForContext, FLUSH_TRIGGER_CHARS, FLUSH_MIN_GROWTH_CHARS } from "../src/agent/prune.js";

const msg = (role: string, text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});
const fcall = (id: string) => ({ type: "function_call", name: "x", arguments: "{}", call_id: id });
const fout = (id: string) => ({ type: "function_call_output", call_id: id, output: "ok" });

describe("prune", () => {
  it("estimateChars sums item sizes", () => {
    expect(estimateChars([msg("user", "hi")])).toBeGreaterThan(0);
    expect(estimateChars([])).toBe(0);
  });

  it("returns the same array when under budget", () => {
    const items = [msg("user", "hi"), msg("assistant", "yo")];
    expect(pruneForContext(items, 1_000_000)).toBe(items);
  });

  it("trims over budget, keeps the first message, no orphan tool output", () => {
    const items: any[] = [msg("user", "FIRST" + "x".repeat(30))];
    for (let i = 0; i < 50; i++) items.push(msg("assistant", "y".repeat(500)));
    const pruned = pruneForContext(items, 3000);
    expect(pruned.length).toBeLessThan(items.length);
    expect(pruned[0].content[0].text).toContain("FIRST");
    expect(pruned[0].type).toBe("message");
  });

  it("never keeps a leading function_call_output whose call was pruned", () => {
    const items: any[] = [msg("user", "a")];
    for (let i = 0; i < 40; i++) {
      items.push(msg("assistant", "z".repeat(400)), fcall("c" + i), fout("c" + i));
    }
    const pruned = pruneForContext(items, 2000);
    expect(pruned[0].type).toBe("message");
  });

  it("exposes flush thresholds", () => {
    expect(FLUSH_TRIGGER_CHARS).toBeGreaterThan(0);
    expect(FLUSH_MIN_GROWTH_CHARS).toBeGreaterThan(0);
  });
});
