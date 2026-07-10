import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpState, cleanup } from "./helpers.js";
import {
  paths,
  stateDir,
  isInside,
  resolveInside,
  resolveReadable,
  writeJsonFileAtomic,
  writeSecretFile,
  ensureStateDirs,
  bundledSkillsDir,
} from "../src/paths.js";

let dir: string;
afterEach(() => cleanup(dir));

describe("state dir resolution", () => {
  it("uses CRABLITE_STATE_DIR when set", () => {
    dir = tmpState();
    expect(stateDir()).toBe(dir);
    expect(paths.config()).toBe(path.join(dir, "config.json"));
    expect(paths.codexAuthFile()).toBe(path.join(dir, "auth", "codex.json"));
  });

  it("ensureStateDirs creates the base layout", () => {
    dir = tmpState();
    ensureStateDirs();
    for (const p of [paths.workspace(), paths.memoryDir(), paths.sessionsDir(), paths.logsDir()]) {
      expect(fs.existsSync(p)).toBe(true);
    }
  });
});

describe("path containment", () => {
  it("isInside respects the separator boundary", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });

  it("resolveInside allows in-root and rejects traversal", () => {
    const root = "/work";
    expect(resolveInside(root, "memory/x.md")).toBe(path.resolve("/work/memory/x.md"));
    expect(() => resolveInside(root, "../secret")).toThrow(/outside/);
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(/outside/);
  });

  it("resolveReadable allows workspace and bundled skills, rejects elsewhere", () => {
    dir = tmpState();
    const ws = paths.workspace();
    expect(resolveReadable(ws, "MEMORY.md")).toBe(path.resolve(ws, "MEMORY.md"));
    const skill = path.join(bundledSkillsDir(), "gog", "SKILL.md");
    expect(resolveReadable(ws, skill)).toBe(skill);
    expect(() => resolveReadable(ws, "/etc/hostname")).toThrow(/readable roots/);
  });
});

describe("atomic + secret writes", () => {
  it("writeJsonFileAtomic round-trips with 0600", () => {
    dir = tmpState();
    const f = path.join(dir, "x.json");
    writeJsonFileAtomic(f, { a: 1 });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toEqual({ a: 1 });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${f}.tmp`)).toBe(false);
  });

  it("writeSecretFile writes 0600", () => {
    dir = tmpState();
    const f = path.join(dir, "sec.txt");
    writeSecretFile(f, "shh");
    expect(fs.readFileSync(f, "utf8")).toBe("shh");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});
