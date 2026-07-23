import { describe, it, expect, afterEach, vi } from "vitest";
import { safeFetchText, isPrivateIp } from "../src/net/safe-fetch.js";

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
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: streamOf("x".repeat(5000)),
      }),
    );
    const t = await safeFetchText("http://8.8.8.8/", { maxBytes: 1000 });
    expect(t.length).toBe(1000);
  });

  it("blocks the whole fe80::/10 link-local range, not just the fe80 prefix", () => {
    // Reachable via DNS: assertPublicHost runs every resolved AAAA address
    // through isPrivateIp, so a host resolving to fe90–febf must be blocked.
    for (const ip of ["fe80::1", "fe90::1", "fea0::1", "feb5::abcd", "febf::1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    // Global-unicast addresses (2000::/3) stay public; fe80::/10 doesn't over-reach.
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });

  it("aborts a stalled response body instead of hanging (timeout covers the body read)", async () => {
    // A server that returns headers, sends a little, then stalls the body forever.
    // The mock wires the abort signal to error the stream — the load-bearing
    // platform behavior this assumes is that undici errors the body stream on abort
    // so a pending reader.read() rejects (which it does on Node >= 20).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const signal = init.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
            // Never close and never enqueue again: the next read stalls until abort.
          },
        });
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), body });
      }),
    );

    // Without the fix, the timer is cleared once headers arrive and readCapped
    // hangs; the race marker would win. With the fix, the 50ms deadline covers the
    // body read and rejects it well before the marker.
    let markerId: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      safeFetchText("http://8.8.8.8/", { timeoutMs: 50 }).then(
        () => "resolved",
        (e) => `rejected:${(e as Error).name}`,
      ),
      new Promise<string>((r) => {
        markerId = setTimeout(() => r("HUNG"), 2000);
      }),
    ]);
    clearTimeout(markerId);
    expect(outcome).toBe("rejected:AbortError");
  });

  it("re-validates the target of a redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: "http://127.0.0.1/" }),
        body: null,
      }),
    );
    await expect(safeFetchText("http://8.8.8.8/", { timeoutMs: 1000 })).rejects.toThrow(/private/);
  });
});
