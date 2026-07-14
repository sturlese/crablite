import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpState, cleanup } from "./helpers.js";
import { paths } from "../src/paths.js";
import {
  seedWorkspace,
  loadProjectContext,
  todayStamp,
  dailyNotePath,
  appendDailyNote,
  listDailyNotes,
  loadRecentDailyNotes,
} from "../src/memory/workspace.js";

let dir: string;
afterEach(() => cleanup(dir));

describe("workspace / memory files", () => {
  it("seeds all bootstrap files", () => {
    dir = tmpState();
    seedWorkspace();
    for (const f of [
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "MEMORY.md",
      "DREAMS.md",
      "HEARTBEAT.md",
    ]) {
      expect(fs.existsSync(path.join(paths.workspace(), f))).toBe(true);
    }
  });

  it("loadProjectContext returns injectable files, ordered, excluding DREAMS/HEARTBEAT", () => {
    dir = tmpState();
    seedWorkspace();
    const names = loadProjectContext().map((f) => f.name);
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("MEMORY.md");
    expect(names).not.toContain("DREAMS.md");
    expect(names).not.toContain("HEARTBEAT.md");
    expect(names.indexOf("AGENTS.md")).toBeLessThan(names.indexOf("SOUL.md"));
    expect(names.indexOf("SOUL.md")).toBeLessThan(names.indexOf("MEMORY.md"));
  });

  it("budgets an oversized file", () => {
    dir = tmpState();
    seedWorkspace();
    fs.writeFileSync(path.join(paths.workspace(), "MEMORY.md"), "x".repeat(20_000));
    const mem = loadProjectContext().find((f) => f.name === "MEMORY.md")!;
    expect(mem.content.length).toBeLessThan(13_000);
    expect(mem.content).toContain("truncated");
  });

  it("daily notes: append, list, and recent-context load", () => {
    dir = tmpState();
    seedWorkspace();
    expect(dailyNotePath()).toContain(todayStamp());
    appendDailyNote("- a durable fact");
    expect(fs.existsSync(dailyNotePath())).toBe(true);
    expect(listDailyNotes()).toHaveLength(1);
    expect(loadRecentDailyNotes()).toContain("a durable fact");
  });
});
