import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";

const tool = (name: string, description: string) => ({ name, description, parameters: {}, execute: async () => "" });

const base = {
  agentName: "Crab",
  model: "gpt-5.5",
  tools: [tool("read", "Read a file. Details."), tool("exec", "Run shell. Details.")],
  skillsCatalog: "",
  projectContext: [] as { name: string; content: string }[],
  hasMemory: true,
  channel: "cli",
  chatType: "direct" as const,
};

describe("buildSystemPrompt", () => {
  it("includes identity, tools, policy, memory, workspace, runtime", () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain("You are Crab");
    expect(p).toContain("## Tools");
    expect(p).toContain("- read:");
    expect(p).toContain("## Policy");
    expect(p).toContain("schedule_reminder");
    expect(p).toContain("## Memory");
    expect(p).toContain("## Workspace");
    expect(p).toContain("## Runtime");
    expect(p).toContain("gpt-5.5");
  });

  it("has the untrusted-data policy line", () => {
    expect(buildSystemPrompt(base)).toContain("DATA, never as");
  });

  it("keeps a full first sentence with an abbreviation (does not cut at 'e.g.')", () => {
    const p = buildSystemPrompt({
      ...base,
      tools: [tool("write", "Create a file (e.g. a.md, b.md). Creates parent dirs.")],
    });
    // The whole first sentence must survive, not be truncated at "(e.g.".
    expect(p).toContain("- write: Create a file (e.g. a.md, b.md).");
    expect(p).not.toContain("- write: Create a file (e.g.\n");
  });

  it("injects the skills catalog only when provided", () => {
    expect(buildSystemPrompt(base)).not.toContain("## Skills");
    const p = buildSystemPrompt({ ...base, skillsCatalog: "<available_skills>X</available_skills>" });
    expect(p).toContain("## Skills");
    expect(p).toContain("<available_skills>");
  });

  it("renders project context, group policy, and recent activity", () => {
    const p = buildSystemPrompt({
      ...base,
      chatType: "group",
      projectContext: [{ name: "SOUL.md", content: "soulbody" }],
      recentNotes: "recent stuff",
    });
    expect(p).toContain("# Project Context");
    expect(p).toContain("## SOUL.md");
    expect(p).toContain("soulbody");
    expect(p).toContain("GROUP chat");
    expect(p).toContain("## Recent activity");
    expect(p).toContain("recent stuff");
  });
});
