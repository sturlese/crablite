import { describe, it, expect, afterEach } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs } from "../src/paths.js";
import { recordRecall, allEntries, markPromoted, keyFor } from "../src/memory/recall.js";

let dir: string;
afterEach(() => cleanup(dir));

describe("recall tracking", () => {
  it("keyFor is deterministic and 16 chars", () => {
    const k = keyFor("hello");
    expect(k).toHaveLength(16);
    expect(keyFor("hello")).toBe(k);
  });

  it("accumulates count, max score, and distinct queries", () => {
    dir = tmpState();
    ensureStateDirs();
    recordRecall({ snippet: "a fact", source: "memory/2026-07-10.md:1-1", score: 0.5, query: "q1" });
    recordRecall({ snippet: "a fact", source: "memory/2026-07-10.md:1-1", score: 0.9, query: "q2" });
    const e = allEntries();
    expect(e).toHaveLength(1);
    expect(e[0]!.recallCount).toBe(2);
    expect(e[0]!.maxScore).toBe(0.9);
    expect(e[0]!.queryHashes).toHaveLength(2);
  });

  it("markPromoted sets promotedAt", () => {
    dir = tmpState();
    ensureStateDirs();
    recordRecall({ snippet: "x", source: "memory/d.md:1-1", score: 0.5, query: "q" });
    markPromoted([allEntries()[0]!.key]);
    expect(allEntries()[0]!.promotedAt).toBeTruthy();
  });
});
