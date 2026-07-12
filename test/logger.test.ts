import { describe, it, expect, afterEach, vi } from "vitest";

// The logger reads CRABLITE_LOG_LEVEL once at module load, so each case stubs the
// env and re-imports a fresh module instance.
async function loadLoggerWith(level: string) {
  vi.resetModules();
  vi.stubEnv("CRABLITE_LOG_LEVEL", level);
  return (await import("../src/logger.js")).log;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("logger threshold", () => {
  it("still emits errors when CRABLITE_LOG_LEVEL is an unrecognized value", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = await loadLoggerWith("verbose"); // typo / not a real level
    log.error("boom");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("boom");
  });

  it("honors a valid level (info shows info, hides debug)", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const log = await loadLoggerWith("info");
    log.debug("dbg");
    expect(out).not.toHaveBeenCalled();
    log.info("hi");
    expect(out).toHaveBeenCalled();
  });
});
