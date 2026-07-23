import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpState, cleanup } from "./helpers.js";
import { paths } from "../src/paths.js";
import { seedWorkspace } from "../src/memory/workspace.js";
import { MEMORY_TOOLS, memorySearchTool, memoryGetTool } from "../src/memory/search.js";
import { allEntries } from "../src/memory/recall.js";

let dir: string;
afterEach(() => cleanup(dir));

function setup(): any {
  dir = tmpState();
  seedWorkspace();
  return { workspaceDir: paths.workspace(), depth: 0 };
}

describe("memory search", () => {
  it("finds a matching daily note and records a recall signal", async () => {
    const ctx = setup();
    fs.writeFileSync(
      path.join(paths.memoryDir(), "2026-07-10.md"),
      "# day\n\nThe dog is named Pixel, a border collie.\n",
    );
    const out = await memorySearchTool.execute({ query: "what is the dog breed" }, ctx);
    expect(out).toContain("Pixel");
    expect(out).toContain("memory/2026-07-10.md");
    expect(allEntries().length).toBe(1);
  });

  it("records one recall per search even when the snippet is duplicated in a file", async () => {
    const ctx = setup();
    // Same fact appears in two separate blocks of the same daily note — a real
    // outcome of stateless flushes re-appending overlapping context.
    const fact = "The dog is named Pixel, a border collie.";
    fs.writeFileSync(
      path.join(paths.memoryDir(), "2026-07-10.md"),
      `# day\n\n${fact}\n\n${fact}\n`,
    );
    await memorySearchTool.execute({ query: "what is the dog breed" }, ctx);
    expect(allEntries()).toHaveLength(1);
    // One search over a 2x-duplicated fact must count as a single recall event.
    expect(allEntries()[0]!.recallCount).toBe(1);
  });

  it("reports no match and rejects an empty query", async () => {
    const ctx = setup();
    expect(await memorySearchTool.execute({ query: "zzz nonexistentterm qqq" }, ctx)).toMatch(
      /No memory matched/,
    );
    expect(await memorySearchTool.execute({ query: "   " }, ctx)).toMatch(/empty query/);
  });

  it("memory_get returns an excerpt and blocks traversal", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(paths.memoryDir(), "2026-07-10.md"), "l1\nl2\nl3");
    expect(
      await memoryGetTool.execute({ path: "memory/2026-07-10.md", start: 2, end: 2 }, ctx),
    ).toBe("l2");
    expect(await memoryGetTool.execute({ path: "../../etc/passwd" }, ctx)).toMatch(
      /outside workspace/,
    );
    expect(await memoryGetTool.execute({ path: "memory/nope.md" }, ctx)).toMatch(/not found/);
  });

  it("memory_search still finds hits when maxResults is non-numeric", async () => {
    const ctx = setup();
    fs.writeFileSync(
      path.join(paths.memoryDir(), "2026-07-10.md"),
      "# day\n\nThe dog is named Pixel, a border collie.\n",
    );
    // The model may emit a string for the number field (tool args are strict:false).
    // Without the guard, Number("all") is NaN → slice(0, NaN) → [] → false "no match".
    const out = await memorySearchTool.execute(
      { query: "what is the dog breed", maxResults: "all" },
      ctx,
    );
    expect(out).toContain("Pixel");
    expect(out).not.toMatch(/No memory matched/);
  });

  it("memory_get returns the excerpt when start/end are non-numeric", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(paths.memoryDir(), "2026-07-10.md"), "l1\nl2\nl3");
    // A non-numeric start/end coerced to NaN and slice(NaN) returned "" — each must
    // fall back to its default (line 1 onward / the windowed end) and return content.
    expect(await memoryGetTool.execute({ path: "memory/2026-07-10.md", start: "oops" }, ctx)).toBe(
      "l1\nl2\nl3",
    );
    expect(await memoryGetTool.execute({ path: "memory/2026-07-10.md", end: "oops" }, ctx)).toBe(
      "l1\nl2\nl3",
    );
  });

  it("exports both read tools", () => {
    expect(MEMORY_TOOLS.map((t) => t.name).sort()).toEqual(["memory_get", "memory_search"]);
  });
});
