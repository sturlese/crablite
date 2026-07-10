import { describe, it, expect, afterEach, vi } from "vitest";
import { safeFetchText } from "../src/net/safe-fetch.js";

afterEach(() => vi.unstubAllGlobals());

function streamOf(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      c.enqueue(enc);
      c.close();
    },
  });
}

describe("safeFetchText SSRF guard", () => {
  it("rejects non-http(s) schemes and private/loopback/metadata IPs", async () => {
    for (const u of [
      "file:///etc/passwd",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/",
      "http://172.16.0.1/",
      "http://100.64.0.1/",
    ]) {
      await expect(safeFetchText(u, { timeoutMs: 1000 })).rejects.toThrow();
    }
  });

  it("fetches a public host (mocked) and caps the body size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: streamOf("x".repeat(5000)) }),
    );
    const t = await safeFetchText("http://8.8.8.8/", { maxBytes: 1000 });
    expect(t.length).toBe(1000);
  });

  it("re-validates the target of a redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ status: 302, headers: new Headers({ location: "http://127.0.0.1/" }), body: null }),
    );
    await expect(safeFetchText("http://8.8.8.8/", { timeoutMs: 1000 })).rejects.toThrow(/private/);
  });
});
