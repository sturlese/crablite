import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpState, cleanup } from "./helpers.js";
import { paths, ensureStateDirs } from "../src/paths.js";
import { loadSkills, formatSkillCatalog, hasBinary } from "../src/skills/loader.js";

const FAKE_BIN = "definitely-not-a-real-binary-xyz";
let dir: string;
afterEach(() => cleanup(dir));

function writeSkill(name: string, frontmatter: string, body = "body"): void {
  const d = path.join(paths.skillsDir(), name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
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
});
