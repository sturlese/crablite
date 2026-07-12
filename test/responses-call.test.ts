import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../src/codex/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex/auth.js")>();
  return { ...actual, getAccessToken: vi.fn().mockResolvedValue({ access: "tok", accountId: "acc" }) };
});

import { callModel } from "../src/codex/responses.js";

afterEach(() => vi.unstubAllGlobals());

function sseStream(events: { event: string; data: unknown }[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  const enc = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      c.enqueue(enc);
      c.close();
    },
  });
}

describe("callModel (Codex Responses API)", () => {
  it("streams text deltas, collects tool calls, and sends auth headers", async () => {
    const events = [
      { event: "response.output_text.delta", data: { delta: "Hel" } },
      { event: "response.output_text.delta", data: { delta: "lo" } },
      { event: "response.output_item.done", data: { item: { type: "function_call", name: "read", arguments: '{"p":1}', call_id: "c1" } } },
      { event: "response.completed", data: {} },
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", body: sseStream(events) });
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const r = await callModel({
      model: "gpt-5.5",
      instructions: "i",
      input: [],
      tools: [{ name: "read", description: "d", parameters: {} }],
      onTextDelta: (d) => deltas.push(d),
    });

    expect(r.text).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ callId: "c1", name: "read", arguments: '{"p":1}' });

    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toContain("/responses");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["ChatGPT-Account-Id"]).toBe("acc");
  });

  it("throws on a non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: "Too Many", body: null, text: async () => "rate limited" }),
    );
    await expect(callModel({ model: "m", instructions: "i", input: [], tools: [] })).rejects.toThrow(/failed/);
  });

  it("surfaces a model error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", body: sseStream([{ event: "response.failed", data: { error: { message: "boom" } } }]) }),
    );
    await expect(callModel({ model: "m", instructions: "i", input: [], tools: [] })).rejects.toThrow(/boom/);
  });

  it("surfaces the error nested under response for a real response.failed event", async () => {
    // The real Responses API nests the failure under `response.error`, not a
    // top-level `error` — the reason must not be swallowed as "unknown model error".
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        body: sseStream([
          { event: "response.failed", data: { type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "Rate limit reached" } } } },
        ]),
      }),
    );
    await expect(callModel({ model: "m", instructions: "i", input: [], tools: [] })).rejects.toThrow(/Rate limit reached/);
  });

  it("surfaces a top-level error event message", async () => {
    // A standalone `error` event keeps the message at the top level.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", body: sseStream([{ event: "error", data: { type: "error", message: "stream broke" } }]) }),
    );
    await expect(callModel({ model: "m", instructions: "i", input: [], tools: [] })).rejects.toThrow(/stream broke/);
  });
});
