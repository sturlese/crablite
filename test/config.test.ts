import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { tmpState, cleanup } from "./helpers.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { paths } from "../src/paths.js";

let dir: string;
afterEach(() => cleanup(dir));

describe("config", () => {
  it("ships secure defaults (closed allowlist, gpt-5.5)", () => {
    dir = tmpState();
    const c = loadConfig();
    expect(c.model).toBe("gpt-5.5");
    expect(c.allowFrom).toEqual([]);
    expect(c.agentName).toBe("Crab");
    expect(c.dreaming).toBe(true);
    expect(c.maxSubagentDepth).toBe(2);
  });

  it("merges config.json", () => {
    dir = tmpState();
    fs.writeFileSync(paths.config(), JSON.stringify({ agentName: "Bob", allowFrom: ["123"] }));
    resetConfigCache();
    const c = loadConfig();
    expect(c.agentName).toBe("Bob");
    expect(c.allowFrom).toEqual(["123"]);
  });

  it("env overrides win and strip a provider prefix", () => {
    dir = tmpState();
    process.env.CRABLITE_MODEL = "openai/gpt-5.5";
    process.env.CRABLITE_ALLOW_FROM = "34600, 34611";
    process.env.CRABLITE_DREAMING = "0";
    process.env.CRABLITE_PRIMARY_CHAT = "34600@s.whatsapp.net";
    resetConfigCache();
    const c = loadConfig();
    expect(c.model).toBe("gpt-5.5");
    expect(c.allowFrom).toEqual(["34600", "34611"]);
    expect(c.dreaming).toBe(false);
    expect(c.heartbeatChat).toBe("34600@s.whatsapp.net");
  });

  it("tolerates malformed config.json", () => {
    dir = tmpState();
    fs.writeFileSync(paths.config(), "{ not json");
    resetConfigCache();
    expect(loadConfig().model).toBe("gpt-5.5");
  });
});
