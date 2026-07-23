import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpState, cleanup } from "./helpers.js";
import { paths } from "../src/paths.js";
import { seedWorkspace, todayStamp } from "../src/memory/workspace.js";
import { recordRecall } from "../src/memory/recall.js";
import { runDreaming } from "../src/memory/dreaming.js";

let dir: string;
afterEach(() => cleanup(dir));

function seedRecall(snippet: string, source: string, times: number, score = 0.9): void {
  for (let i = 0; i < times; i++)
    recordRecall({ snippet, source, score, query: "distinct query number " + i });
}
const memoryText = () => fs.readFileSync(path.join(paths.workspace(), "MEMORY.md"), "utf8");

describe("dreaming (self-learning)", () => {
  it("promotes a frequently-recalled note with provenance + marker, idempotently", async () => {
    dir = tmpState();
    seedWorkspace();
    fs.writeFileSync(
      path.join(paths.memoryDir(), "2026-07-09.md"),
      "# d\n\nThe cat sleeps a lot.\n",
    );
    seedRecall("The cat sleeps a lot.", "memory/2026-07-09.md:3-3", 3);

    const res = await runDreaming(); // no model -> reflection falls back to templated
    expect(res.promoted).toBe(1);

    const mem = memoryText();
    expect(mem).toContain("cat sleeps");
    expect(mem).toContain("crablite-promotion:");
    expect(mem).toMatch(/\[score=.*recalls=3.*source=memory\/2026-07-09\.md/);

    const dreams = fs.readFileSync(path.join(paths.workspace(), "DREAMS.md"), "utf8");
    expect(dreams).toContain(`## ${todayStamp()}`);

    // Re-running must not re-promote (idempotency marker + promotedAt).
    expect((await runDreaming()).promoted).toBe(0);
  });

  it("does not report or mark a promotion that compaction evicted", async () => {
    dir = tmpState();
    seedWorkspace();
    const memoryPath = path.join(paths.workspace(), "MEMORY.md");
    // User content alone exceeds the 10k budget, so any appended promotion
    // section is evicted by compactMemory.
    fs.writeFileSync(memoryPath, "# Memory\n\n" + "x".repeat(10_001) + "\n");
    fs.writeFileSync(
      path.join(paths.memoryDir(), "2026-07-09.md"),
      "# d\n\nThe cat sleeps a lot.\n",
    );
    seedRecall("The cat sleeps a lot.", "memory/2026-07-09.md:3-3", 3);

    const res = await runDreaming();
    expect(res.promoted).toBe(0); // nothing actually landed in MEMORY.md
    expect(memoryText()).not.toContain("cat sleeps");

    // The entry must stay eligible (promotedAt NOT set), so once there is room a
    // later sweep promotes it. Without the fix it was marked on the first run and
    // lost forever.
    fs.writeFileSync(memoryPath, "# Memory\n\n");
    const res2 = await runDreaming();
    expect(res2.promoted).toBe(1);
    expect(memoryText()).toContain("cat sleeps");
  });

  it("compaction keeps user content when MEMORY.md contains the heading text in a comment", async () => {
    dir = tmpState();
    seedWorkspace();
    const memoryPath = path.join(paths.workspace(), "MEMORY.md");
    // The seeded template quotes the promotion heading inside an HTML comment.
    // A user note sits after it, then a large old promotion section that is the
    // legitimate eviction target once a new promotion tips the file over budget.
    fs.writeFileSync(
      memoryPath,
      "# MEMORY\n\n" +
        '<!-- Promoted memories will be appended below under dated "## Promoted From Short-Term Memory" sections. -->\n\n' +
        "USER-NOTE-KEEP-ME: my bank is Revolut.\n\n" +
        "## Promoted From Short-Term Memory (2026-07-01)\n\n" +
        `- OLD-FILLER ${"z".repeat(9800)} <!-- crablite-promotion:0000000a -->\n`,
    );
    fs.writeFileSync(
      path.join(paths.memoryDir(), "2026-07-09.md"),
      "# d\n\nThe cat sleeps a lot.\n",
    );
    seedRecall("The cat sleeps a lot.", "memory/2026-07-09.md:3-3", 3);

    const res = await runDreaming();
    const mem = memoryText();

    // The old promotion section is the correct eviction target — compaction ran.
    expect(mem).not.toContain("OLD-FILLER");
    // The new promotion landed and survived.
    expect(res.promoted).toBe(1);
    expect(mem).toContain("cat sleeps");
    // The user's hand-written note and the template comment must survive: the
    // unanchored match used to cut mid-comment and evict everything after it.
    expect(mem).toContain("USER-NOTE-KEEP-ME");
    expect(mem).toContain("sections. -->");
    // No unterminated comment: the buggy cut left a dangling `<!--` that swallowed
    // the rest of the file. Every opener must still have its closer.
    expect((mem.match(/<!--/g) ?? []).length).toBe((mem.match(/-->/g) ?? []).length);
  });

  it("does not promote below the gates", async () => {
    dir = tmpState();
    seedWorkspace();
    fs.writeFileSync(path.join(paths.memoryDir(), "2026-07-09.md"), "# d\n\nWeak note.\n");
    seedRecall("Weak note.", "memory/2026-07-09.md:3-3", 1); // recallCount 1 < 3
    expect((await runDreaming()).promoted).toBe(0);
  });

  it("skips a candidate whose source no longer exists (rehydrate fails)", async () => {
    dir = tmpState();
    seedWorkspace();
    // No daily file written -> rehydrate returns null.
    seedRecall("Vanished fact.", "memory/2026-07-09.md:3-3", 3);
    const res = await runDreaming();
    expect(res.promoted).toBe(0);
    expect(res.skipped).toBeGreaterThan(0);
  });
});
