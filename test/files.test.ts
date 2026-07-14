import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { tmpState, cleanup } from "./helpers.js";
import { ensureStateDirs, paths } from "../src/paths.js";
import {
  guessMimetype,
  formatSize,
  sanitizeName,
  saveInboundDocument,
} from "../src/media/files.js";

let dir: string;
afterEach(() => cleanup(dir));

const doc = (filename: string | undefined, content = "hello") => ({
  kind: "document" as const,
  data: Buffer.from(content),
  mimetype: "application/pdf",
  filename,
});

describe("guessMimetype / formatSize", () => {
  it("maps common extensions and falls back to octet-stream", () => {
    expect(guessMimetype("a/report.PDF")).toBe("application/pdf");
    expect(guessMimetype("pic.jpeg")).toBe("image/jpeg");
    expect(guessMimetype("note.ogg")).toBe("audio/ogg");
    expect(guessMimetype("data.csv")).toBe("text/csv");
    expect(guessMimetype("weird.xyz")).toBe("application/octet-stream");
  });

  it("formats sizes human-readably", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});

describe("sanitizeName", () => {
  it("flattens separators, strips control chars and leading dots", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeName("factura julio.pdf")).toBe("factura julio.pdf");
    expect(sanitizeName("weird\\name*?.pdf")).toBe("weird_name_.pdf");
    expect(sanitizeName(".hidden")).toBe("hidden");
    expect(sanitizeName("   ")).toBe("document");
  });
});

describe("saveInboundDocument", () => {
  it("saves under inbox/ with a dated, sanitized name and returns the rel path", () => {
    dir = tmpState();
    ensureStateDirs();
    const rel = saveInboundDocument(doc("factura.pdf"));
    expect(rel).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-factura\.pdf$/);
    const abs = path.join(paths.workspace(), rel);
    expect(fs.readFileSync(abs, "utf8")).toBe("hello");
  });

  it("suffixes on collision instead of overwriting", () => {
    dir = tmpState();
    ensureStateDirs();
    const first = saveInboundDocument(doc("a.pdf", "one"));
    const second = saveInboundDocument(doc("a.pdf", "two"));
    expect(second).not.toBe(first);
    expect(second).toMatch(/-2\.pdf$/);
    expect(fs.readFileSync(path.join(paths.workspace(), first), "utf8")).toBe("one");
    expect(fs.readFileSync(path.join(paths.workspace(), second), "utf8")).toBe("two");
  });

  it("defaults the name when the sender provided none", () => {
    dir = tmpState();
    ensureStateDirs();
    expect(saveInboundDocument(doc(undefined))).toMatch(/-document$/);
  });
});
