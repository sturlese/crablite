import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpState, cleanup } from "./helpers.js";
import { paths, ensureStateDirs } from "../src/paths.js";
import { CORE_TOOLS, toSchemas } from "../src/agent/tools.js";

let dir: string;
afterEach(() => {
  cleanup(dir);
  vi.unstubAllGlobals();
});

const tool = (n: string) => CORE_TOOLS.find((t) => t.name === n)!;
function setup(): any {
  dir = tmpState();
  ensureStateDirs();
  return { workspaceDir: paths.workspace(), depth: 0 };
}
function streamOf(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      c.enqueue(enc);
      c.close();
    },
  });
}

describe("core tools", () => {
  it("toSchemas projects name/description/parameters", () => {
    expect(toSchemas(CORE_TOOLS).every((x) => x.name && x.description && x.parameters)).toBe(true);
  });

  it("write then read a file inside the workspace", async () => {
    const ctx = setup();
    expect(await tool("write").execute({ path: "memory/n.md", content: "hello" }, ctx)).toMatch(/Wrote/);
    expect(await tool("read").execute({ path: "memory/n.md" }, ctx)).toBe("hello");
  });

  it("read supports line ranges and reports missing files", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.workspaceDir, "f.md"), "l1\nl2\nl3\nl4");
    expect(await tool("read").execute({ path: "f.md", start: 2, end: 3 }, ctx)).toBe("l2\nl3");
    expect(await tool("read").execute({ path: "nope.md" }, ctx)).toMatch(/not found/);
  });

  it("read blocks paths outside the readable roots", async () => {
    const ctx = setup();
    await expect(tool("read").execute({ path: "/etc/hostname" }, ctx)).rejects.toThrow(/readable roots/);
  });

  it("read caps very large files before buffering", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.workspaceDir, "big.md"), "a".repeat(500_000));
    const out = await tool("read").execute({ path: "big.md" }, ctx);
    expect(out.length).toBeLessThan(200_000); // read cap + output clip
    expect(out).toContain("truncated");
  });

  it("write refuses paths outside the workspace", async () => {
    const ctx = setup();
    await expect(tool("write").execute({ path: "/tmp/evil.txt", content: "x" }, ctx)).rejects.toThrow(/outside/);
  });

  it("edit replaces a unique substring; flags non-unique and not-found", async () => {
    const ctx = setup();
    await tool("write").execute({ path: "e.md", content: "foo bar foo" }, ctx);
    expect(await tool("edit").execute({ path: "e.md", old: "bar", new: "baz" }, ctx)).toMatch(/Edited/);
    expect(await tool("read").execute({ path: "e.md" }, ctx)).toBe("foo baz foo");
    expect(await tool("edit").execute({ path: "e.md", old: "foo", new: "x" }, ctx)).toMatch(/not unique/);
    expect(await tool("edit").execute({ path: "e.md", old: "zzz", new: "x" }, ctx)).toMatch(/not found/);
  });

  it("exec runs a shell command and enforces a timeout", async () => {
    const ctx = setup();
    expect(await tool("exec").execute({ command: "echo hola" }, ctx)).toContain("hola");
    expect(await tool("exec").execute({ command: "sleep 5", timeoutSec: 1 }, ctx)).toContain("timed out");
  });

  it("message requires a chatReply", async () => {
    const ctx = setup();
    expect(await tool("message").execute({ text: "hi" }, ctx)).toMatch(/No channel/);
    const sent: string[] = [];
    expect(await tool("message").execute({ text: "hi" }, { ...ctx, chatReply: async (t: string) => void sent.push(t) })).toMatch(/sent/);
    expect(sent).toEqual(["hi"]);
  });

  it("web_fetch fences output as untrusted and blocks SSRF", async () => {
    const ctx = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: streamOf("<p>Hello <b>world</b></p>") }),
    );
    const out = await tool("web_fetch").execute({ url: "http://8.8.8.8/" }, ctx); // public IP literal, no DNS
    expect(out).toContain("untrusted web content");
    expect(out).toContain("Hello world");
    expect(await tool("web_fetch").execute({ url: "http://127.0.0.1/" }, ctx)).toMatch(/ERROR fetching/);
  });
});
