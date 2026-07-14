import fs from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { loadSession, appendItems, resetSession, getFlushedChars, setFlushedChars } from "../src/session/store.js";

let dir: string;
afterEach(() => cleanup(dir));

const userMsg = (t: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text: t }] });

describe("session store", () => {
  it("creates, persists, and resumes a session", () => {
    dir = tmpState();
    const s = loadSession("k1");
    expect(s.items).toEqual([]);
    appendItems(s, [userMsg("hi")]);
    const s2 = loadSession("k1");
    expect(s2.sessionId).toBe(s.sessionId);
    expect(s2.items).toHaveLength(1);
    expect(s2.items[0].role).toBe("user");
  });

  it("reset mints a fresh session id and empties history", () => {
    dir = tmpState();
    const s = loadSession("k1");
    appendItems(s, [userMsg("hi")]);
    resetSession("k1");
    const s2 = loadSession("k1");
    expect(s2.sessionId).not.toBe(s.sessionId);
    expect(s2.items).toEqual([]);
  });

  it("reset deletes the old transcript file (no orphans)", () => {
    dir = tmpState();
    const s = loadSession("k1");
    appendItems(s, [userMsg("hi")]);
    expect(fs.existsSync(s.file)).toBe(true);
    resetSession("k1");
    expect(fs.existsSync(s.file)).toBe(false);
  });

  it("tracks flushedChars per session", () => {
    dir = tmpState();
    loadSession("k1");
    expect(getFlushedChars("k1")).toBe(0);
    setFlushedChars("k1", 123);
    expect(getFlushedChars("k1")).toBe(123);
  });
});
