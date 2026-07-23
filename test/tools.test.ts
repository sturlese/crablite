import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpState, cleanup } from "./helpers.js";
import { paths, ensureStateDirs } from "../src/paths.js";
import { CORE_TOOLS } from "../src/agent/tools.js";
import { toSchemas } from "../src/agent/tool.js";

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
    expect(await tool("write").execute({ path: "memory/n.md", content: "hello" }, ctx)).toMatch(
      /Wrote/,
    );
    expect(await tool("read").execute({ path: "memory/n.md" }, ctx)).toBe("hello");
  });

  it("read supports line ranges and reports missing files", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.workspaceDir, "f.md"), "l1\nl2\nl3\nl4");
    expect(await tool("read").execute({ path: "f.md", start: 2, end: 3 }, ctx)).toBe("l2\nl3");
    expect(await tool("read").execute({ path: "nope.md" }, ctx)).toMatch(/not found/);
  });

  it("read guards non-finite line ranges instead of returning an empty range", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.workspaceDir, "f.md"), "l1\nl2\nl3\nl4");
    // A non-numeric end coerced to NaN and slice(_, NaN) returned "" — an empty
    // file reported for a file with content. It must fall back to the last line.
    expect(await tool("read").execute({ path: "f.md", end: "oops" }, ctx)).toBe("l1\nl2\nl3\nl4");
    // A non-finite start (Number("Infinity") === Infinity) sliced past the end
    // (also ""); it must fall back to line 1.
    expect(await tool("read").execute({ path: "f.md", start: "Infinity", end: 3 }, ctx)).toBe(
      "l1\nl2\nl3",
    );
  });

  it("read blocks paths outside the readable roots", async () => {
    const ctx = setup();
    await expect(tool("read").execute({ path: "/etc/hostname" }, ctx)).rejects.toThrow(
      /readable roots/,
    );
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
    await expect(
      tool("write").execute({ path: "/tmp/evil.txt", content: "x" }, ctx),
    ).rejects.toThrow(/outside/);
  });

  it("edit replaces a unique substring; flags non-unique and not-found", async () => {
    const ctx = setup();
    await tool("write").execute({ path: "e.md", content: "foo bar foo" }, ctx);
    expect(await tool("edit").execute({ path: "e.md", old: "bar", new: "baz" }, ctx)).toMatch(
      /Edited/,
    );
    expect(await tool("read").execute({ path: "e.md" }, ctx)).toBe("foo baz foo");
    expect(await tool("edit").execute({ path: "e.md", old: "foo", new: "x" }, ctx)).toMatch(
      /not unique/,
    );
    expect(await tool("edit").execute({ path: "e.md", old: "zzz", new: "x" }, ctx)).toMatch(
      /not found/,
    );
  });

  it("exec falls back to the default timeout when timeoutSec is non-numeric", async () => {
    const ctx = setup();
    // Args are raw JSON (strict:false), so the model can send a string here.
    // Without a guard this used to SIGKILL the command at ~1ms and return
    // "[timed out after NaNs]"; it must instead run with the default timeout.
    const out = await tool("exec").execute({ command: "echo hola", timeoutSec: "quick" }, ctx);
    expect(out).toContain("hola");
    expect(out).not.toContain("NaN");
  });

  // The kill-after-1s assertion needs >1s of wall clock by design; on a busy
  // CI runner (2 cores, coverage instrumentation) that can brush the default
  // 5s test timeout, so give it explicit headroom.
  it("exec runs a shell command and enforces a timeout", { timeout: 20_000 }, async () => {
    const ctx = setup();
    expect(await tool("exec").execute({ command: "echo hola" }, ctx)).toContain("hola");
    expect(await tool("exec").execute({ command: "sleep 5", timeoutSec: 1 }, ctx)).toContain(
      "timed out",
    );
  });

  it("message requires a chatReply", async () => {
    const ctx = setup();
    expect(await tool("message").execute({ text: "hi" }, ctx)).toMatch(/No channel/);
    const sent: string[] = [];
    expect(
      await tool("message").execute(
        { text: "hi" },
        { ...ctx, chatReply: async (t: string) => void sent.push(t) },
      ),
    ).toMatch(/sent/);
    expect(sent).toEqual(["hi"]);
  });

  it("send_file delivers a workspace file with mimetype, filename and caption", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.workspaceDir, "report.csv"), "a,b\n1,2\n");
    const sent: any[] = [];
    const out = await tool("send_file").execute(
      { path: "report.csv", caption: "your report" },
      { ...ctx, chatSendFile: async (f: any) => void sent.push(f) },
    );
    expect(out).toMatch(/Sent report\.csv/);
    expect(sent).toHaveLength(1);
    expect(sent[0].mimetype).toBe("text/csv");
    expect(sent[0].filename).toBe("report.csv");
    expect(sent[0].caption).toBe("your report");
    expect(sent[0].data.toString()).toContain("a,b");
  });

  it("send_file refuses without a channel, outside the workspace, and over the cap", async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.workspaceDir, "f.txt"), "x");
    expect(await tool("send_file").execute({ path: "f.txt" }, ctx)).toMatch(/cannot receive files/);

    const sendCtx = { ...ctx, chatSendFile: async () => {} };
    await expect(tool("send_file").execute({ path: "/etc/hostname" }, sendCtx)).rejects.toThrow(
      /outside/,
    );
    expect(await tool("send_file").execute({ path: "nope.bin" }, sendCtx)).toMatch(/not found/);

    fs.writeFileSync(path.join(ctx.workspaceDir, "big.bin"), Buffer.alloc(21 * 1024 * 1024));
    expect(await tool("send_file").execute({ path: "big.bin" }, sendCtx)).toMatch(/send cap/);
  });

  it("react sends a single emoji through the channel", async () => {
    const ctx = setup();
    const reactions: string[] = [];
    const reactCtx = { ...ctx, chatReact: async (e: string) => void reactions.push(e) };
    expect(await tool("react").execute({ emoji: "👍" }, reactCtx)).toContain("Reacted with 👍");
    expect(reactions).toEqual(["👍"]);
    expect(await tool("react").execute({ emoji: "" }, reactCtx)).toMatch(/exactly one emoji/);
    expect(await tool("react").execute({ emoji: "hello there" }, reactCtx)).toMatch(
      /exactly one emoji/,
    );
    expect(await tool("react").execute({ emoji: "👍" }, ctx)).toMatch(/does not support/);
  });

  it("web_fetch fences output as untrusted and blocks SSRF", async () => {
    const ctx = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: streamOf("<p>Hello <b>world</b></p>"),
      }),
    );
    const out = await tool("web_fetch").execute({ url: "http://8.8.8.8/" }, ctx); // public IP literal, no DNS
    expect(out).toContain("untrusted web content");
    expect(out).toContain("Hello world");
    expect(await tool("web_fetch").execute({ url: "http://127.0.0.1/" }, ctx)).toMatch(
      /ERROR fetching/,
    );
  });
});
