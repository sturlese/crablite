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
    fs.writeFileSync(path.join(paths.memoryDir(), "2026-07-10.md"), "# day\n\nThe dog is named Pixel, a border collie.\n");
    const out = await memorySearchTool.execute({ query: "what is the dog breed" }, ctx);
    expect(out).toContain("Pixel");
    expect(out).toContain("memory/2026-07-10.md");
    expect(allEntries().length).toBe(1);
  });

  it("reports no match and rejects an empty query", async () => {
    const ctx = setup();
    expect(await memorySearchTool.execute({ query: "zzz nonexistentterm qqq" }, ctx)).toMatch(/No memory matched/);
    expect(await memorySearchTool.execute({ query: "   " }, ctx)).toMatch(/empty query/);
  });

  it("memory_get returns an excerpt and blocks traversal", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(paths.memoryDir(), "2026-07-10.md"), "l1\nl2\nl3");
    expect(await memoryGetTool.execute({ path: "memory/2026-07-10.md", start: 2, end: 2 }, ctx)).toBe("l2");
    expect(await memoryGetTool.execute({ path: "../../etc/passwd" }, ctx)).toMatch(/outside workspace/);
    expect(await memoryGetTool.execute({ path: "memory/nope.md" }, ctx)).toMatch(/not found/);
  });

  it("exports both read tools", () => {
    expect(MEMORY_TOOLS.map((t) => t.name).sort()).toEqual(["memory_get", "memory_search"]);
  });
});
