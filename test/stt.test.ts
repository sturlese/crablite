import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { paths, writeSecretFile } from "../src/paths.js";
import { transcribeAudio } from "../src/media/stt.js";

let dir: string;
afterEach(() => {
  cleanup(dir);
  vi.unstubAllGlobals();
});

const login = () =>
  writeSecretFile(
    paths.codexAuthFile(),
    JSON.stringify({ version: 1, access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "acc" }),
  );

describe("stt (Codex transcription, no extra key)", () => {
  it("transcribes with the Codex credential", async () => {
    dir = tmpState();
    login();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: "hola mundo" }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribeAudio(Buffer.from("audio"), "audio/ogg")).toBe("hola mundo");
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toContain("/audio/transcriptions");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["ChatGPT-Account-Id"]).toBe("acc");
  });

  it("returns null on a failed transcription", async () => {
    dir = tmpState();
    login();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad" }));
    expect(await transcribeAudio(Buffer.from("x"), "audio/ogg")).toBe(null);
  });

  it("returns null when not logged in", async () => {
    dir = tmpState();
    expect(await transcribeAudio(Buffer.from("x"), "audio/ogg")).toBe(null);
  });
});
