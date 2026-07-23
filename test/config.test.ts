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

  it('disables dreaming for common falsy env spellings, not just "0"', () => {
    dir = tmpState();
    for (const falsy of ["0", "false", "no", "off", "FALSE", "Off"]) {
      process.env.CRABLITE_DREAMING = falsy;
      resetConfigCache();
      expect(loadConfig().dreaming, `${falsy} should disable dreaming`).toBe(false);
    }
    for (const truthy of ["1", "true", "yes", "on"]) {
      process.env.CRABLITE_DREAMING = truthy;
      resetConfigCache();
      expect(loadConfig().dreaming, `${truthy} should enable dreaming`).toBe(true);
    }
    delete process.env.CRABLITE_DREAMING;
    resetConfigCache();
  });

  it("tolerates malformed config.json", () => {
    dir = tmpState();
    fs.writeFileSync(paths.config(), "{ not json");
    resetConfigCache();
    expect(loadConfig().model).toBe("gpt-5.5");
  });

  it("ignores wrong-typed config values instead of crashing (model)", () => {
    dir = tmpState();
    // Valid JSON, wrong type: a number or null model makes the provider-prefix
    // strip `merged.model.includes(...)` throw and kills startup; any non-string
    // must fall back to the default instead.
    for (const bad of [{ model: 5.5 }, { model: null }, { model: ["x"] }]) {
      fs.writeFileSync(paths.config(), JSON.stringify(bad));
      resetConfigCache();
      let c: ReturnType<typeof loadConfig>;
      expect(() => {
        c = loadConfig();
      }).not.toThrow();
      expect(c!.model).toBe("gpt-5.5");
    }
  });

  it("keeps the allowlist closed when allowFrom is not a string[] (no fail-open)", () => {
    dir = tmpState();
    // A string allowFrom would satisfy `.length !== 0` (not fail-closed) and, if it
    // contains "*", `includes("*")` → admit everyone. It must fall back to [].
    for (const bad of [
      { allowFrom: "34600*" },
      { allowFrom: "*" },
      { allowFrom: ["ok", 5] },
      {
        allowFrom: {},
      },
    ]) {
      fs.writeFileSync(paths.config(), JSON.stringify(bad));
      resetConfigCache();
      const c = loadConfig();
      expect(Array.isArray(c.allowFrom)).toBe(true);
      expect(c.allowFrom).toEqual([]);
    }
  });

  it("keeps a valid allowFrom array", () => {
    dir = tmpState();
    fs.writeFileSync(paths.config(), JSON.stringify({ allowFrom: ["34600", "34611"] }));
    resetConfigCache();
    expect(loadConfig().allowFrom).toEqual(["34600", "34611"]);
  });
});
