import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpState, cleanup } from "./helpers.js";
import { paths, ensureStateDirs } from "../src/paths.js";
import {
  loadSkills,
  formatSkillCatalog,
  formatSkillLine,
  formatSkillsSummary,
  hasBinary,
  type Skill,
} from "../src/skills/loader.js";

const FAKE_BIN = "definitely-not-a-real-binary-xyz";
let dir: string;
afterEach(() => cleanup(dir));

function writeSkill(name: string, frontmatter: string, body = "body"): void {
  const d = path.join(paths.skillsDir(), name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

/** Typed fixture factory for the exported `Skill` shape — no fs/tmpState needed. */
function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "sample",
    description: "A sample skill.",
    location: "/fake/skills/sample/SKILL.md",
    requiresBins: [],
    eligible: true,
    learned: false,
    ...overrides,
  };
}

describe("skills loader", () => {
  it("hasBinary detects real vs fake binaries", () => {
    expect(hasBinary("sh")).toBe(true);
    expect(hasBinary(FAKE_BIN)).toBe(false);
  });

  it("loads the bundled skills (gog gated on the gog binary)", () => {
    dir = tmpState();
    ensureStateDirs();
    const skills = loadSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain("gog");
    expect(names).toContain("weather");
    expect(skills.find((s) => s.name === "gog")!.requiresBins).toContain("gog");
  });

  it("parses name/description, skips invalid, gates on requires.bins", () => {
    dir = tmpState();
    ensureStateDirs();
    writeSkill("valid", `name: valid\ndescription: A valid skill.`);
    writeSkill(
      "gated",
      `name: gated\ndescription: Needs a fake bin.\nmetadata:\n  crablite:\n    requires:\n      bins: ["${FAKE_BIN}"]`,
    );
    writeSkill("nodesc", `name: nodesc`);
    const skills = loadSkills();
    expect(skills.find((s) => s.name === "valid")!.eligible).toBe(true);
    expect(skills.find((s) => s.name === "gated")!.eligible).toBe(false);
    expect(skills.find((s) => s.name === "nodesc")).toBeUndefined();
  });

  it("honors a YAML dash-list for bins (ReDoS-safe parse)", () => {
    dir = tmpState();
    ensureStateDirs();
    writeSkill(
      "dash",
      `name: dash\ndescription: Dash list.\nmetadata:\n  crablite:\n    requires:\n      bins:\n        - ${FAKE_BIN}`,
    );
    const d = loadSkills().find((s) => s.name === "dash")!;
    expect(d.requiresBins).toContain(FAKE_BIN);
    expect(d.eligible).toBe(false);
  });

  it("treats anyBins as OR (eligible if one present) but bins as AND", () => {
    dir = tmpState();
    ensureStateDirs();
    // anyBins: at least one present -> eligible (sh exists, fake does not).
    writeSkill(
      "any-ok",
      `name: any-ok\ndescription: Any of these.\nmetadata:\n  crablite:\n    requires:\n      anyBins: ["sh", "${FAKE_BIN}"]`,
    );
    // anyBins: none present -> ineligible.
    writeSkill(
      "any-none",
      `name: any-none\ndescription: None present.\nmetadata:\n  crablite:\n    requires:\n      anyBins: ["${FAKE_BIN}", "${FAKE_BIN}-2"]`,
    );
    // bins stays AND: one missing -> ineligible even though sh is present.
    writeSkill(
      "all-req",
      `name: all-req\ndescription: All required.\nmetadata:\n  crablite:\n    requires:\n      bins: ["sh", "${FAKE_BIN}"]`,
    );
    const skills = loadSkills();
    expect(skills.find((s) => s.name === "any-ok")!.eligible).toBe(true);
    expect(skills.find((s) => s.name === "any-none")!.eligible).toBe(false);
    expect(skills.find((s) => s.name === "all-req")!.eligible).toBe(false);
  });

  it("workspace skills override bundled by name", () => {
    dir = tmpState();
    ensureStateDirs();
    writeSkill("weather", `name: weather\ndescription: Overridden weather.`);
    expect(loadSkills().find((s) => s.name === "weather")!.description).toBe("Overridden weather.");
  });

  it("formatSkillCatalog lists only eligible skills", () => {
    dir = tmpState();
    ensureStateDirs();
    writeSkill("valid", `name: valid\ndescription: A valid skill.`);
    const cat = formatSkillCatalog(loadSkills());
    expect(cat).toContain("<available_skills>");
    expect(cat).toContain("valid");
    expect(cat).not.toContain(FAKE_BIN);
  });

  it("learned:true under metadata.crablite sets Skill.learned", () => {
    dir = tmpState();
    ensureStateDirs();
    writeSkill(
      "crablite-learned",
      `name: crablite-learned\ndescription: A self-taught skill.\nmetadata:\n  crablite:\n    learned: true`,
    );
    expect(loadSkills().find((s) => s.name === "crablite-learned")!.learned).toBe(true);
  });

  it("learned:true under metadata.openclaw sets Skill.learned (OpenClaw skills drop in unchanged)", () => {
    dir = tmpState();
    ensureStateDirs();
    writeSkill(
      "openclaw-learned",
      `name: openclaw-learned\ndescription: An OpenClaw-authored skill.\nmetadata:\n  openclaw:\n    learned: true`,
    );
    expect(loadSkills().find((s) => s.name === "openclaw-learned")!.learned).toBe(true);
  });

  it("learned defaults to false: absent key, and an explicit learned:false", () => {
    dir = tmpState();
    ensureStateDirs();
    writeSkill("no-learned-key", `name: no-learned-key\ndescription: No provenance marker at all.`);
    writeSkill(
      "learned-false",
      `name: learned-false\ndescription: Explicitly not learned.\nmetadata:\n  crablite:\n    learned: false`,
    );
    const skills = loadSkills();
    expect(skills.find((s) => s.name === "no-learned-key")!.learned).toBe(false);
    expect(skills.find((s) => s.name === "learned-false")!.learned).toBe(false);
  });

  it("a 'learned: true' substring inside a scalar value does not set the flag", () => {
    dir = tmpState();
    ensureStateDirs();
    // The description's own prose ends in the literal substring "learned: true" —
    // an unanchored regex (matching "learned:" anywhere in the line, not only at
    // line-start) would capture exactly "true" here and false-positive. isLearned
    // anchors on line-start (optional indentation only), so this must stay false.
    writeSkill(
      "sneaky-value",
      `name: sneaky-value\ndescription: "after this project we finally learned: true"`,
    );
    expect(loadSkills().find((s) => s.name === "sneaky-value")!.learned).toBe(false);
  });

  it("loadSkills() picks up a skill written after an earlier call, same process (per-turn liveness, no restart)", () => {
    dir = tmpState();
    ensureStateDirs();
    const before = loadSkills();
    expect(before.find((s) => s.name === "just-taught")).toBeUndefined();
    writeSkill(
      "just-taught",
      `name: just-taught\ndescription: Written mid-conversation, after the first loadSkills() call.\nmetadata:\n  crablite:\n    learned: true`,
    );
    const after = loadSkills();
    const found = after.find((s) => s.name === "just-taught");
    expect(found).toBeDefined();
    expect(found!.learned).toBe(true);
  });

  it("bundled skill-creator parses, is eligible, requires no binaries, and is not itself marked learned", () => {
    dir = tmpState();
    ensureStateDirs();
    const skill = loadSkills().find((s) => s.name === "skill-creator");
    expect(skill).toBeDefined();
    expect(skill!.eligible).toBe(true);
    expect(skill!.requiresBins).toEqual([]);
    expect(skill!.learned).toBe(false);
  });
});

describe("doctor formatting (pure)", () => {
  // formatSkillLine / formatSkillsSummary take plain Skill data in and a string out —
  // no filesystem, no tmpState. This is what `crablite doctor` (an untested thin I/O
  // shell, per src/index.md) delegates to for the parts worth pinning precisely.

  it("formatSkillLine: eligible, not learned, no requiresBins -> bare name, single space", () => {
    expect(formatSkillLine(fakeSkill({ name: "weather" }))).toBe("✅ weather");
  });

  it("formatSkillLine: requiresBins alone appends ' (needs: a,b)' with no learned tag", () => {
    expect(formatSkillLine(fakeSkill({ name: "gog", requiresBins: ["gog", "curl"] }))).toBe(
      "✅ gog (needs: gog,curl)",
    );
  });

  it("formatSkillLine: learned + requiresBins -> exact order 'name (learned) (needs: …)'", () => {
    expect(
      formatSkillLine(fakeSkill({ name: "expense-report", learned: true, requiresBins: ["curl"] })),
    ).toBe("✅ expense-report (learned) (needs: curl)");
  });

  it("formatSkillLine: not eligible uses the pause icon, which carries its own trailing space", () => {
    // "⏸ " (icon + baked-in space) + the template's own " " before the name -> two
    // spaces between icon and name. Pin this exactly; it's an easy accidental typo.
    expect(formatSkillLine(fakeSkill({ name: "hidden", eligible: false }))).toBe("⏸  hidden");
  });

  it("formatSkillsSummary: zero learned skills omits the suffix entirely (exact string)", () => {
    const skills = [
      fakeSkill({ name: "a", eligible: true }),
      fakeSkill({ name: "b", eligible: false }),
    ];
    expect(formatSkillsSummary(skills)).toBe("1 eligible / 2 found");
  });

  it("formatSkillsSummary: K>0 learned skills appends ' (K learned)' (exact string)", () => {
    const skills = [
      fakeSkill({ name: "a", eligible: true, learned: true }),
      fakeSkill({ name: "b", eligible: true, learned: true }),
      fakeSkill({ name: "c", eligible: false, learned: false }),
    ];
    expect(formatSkillsSummary(skills)).toBe("2 eligible / 3 found (2 learned)");
  });
});
