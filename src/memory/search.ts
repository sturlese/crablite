// memory_search + memory_get — the two-tool read contract (OpenClaw:
// extensions/memory-core/index.ts:190-196). Lexical scoring keeps crablite
// dependency-free; the signature is upgrade-ready for embeddings later.
//
// A hit on a DAILY note records a recall signal (feeds dreaming).

import fs from "node:fs";
import path from "node:path";
import { paths, resolveInside } from "../paths.js";
import { recordRecall } from "./recall.js";
import type { Tool } from "../agent/tools.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were",
  "with", "as", "at", "by", "it", "this", "that", "be", "do", "does", "i", "you", "he", "she",
  "we", "they", "my", "me", "what", "when", "who", "how", "about",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

type Block = { file: string; rel: string; startLine: number; endLine: number; text: string; isDaily: boolean };

function collectBlocks(): Block[] {
  const ws = paths.workspace();
  const blocks: Block[] = [];
  const files: string[] = [];

  const memoryMd = path.join(ws, "MEMORY.md");
  if (fs.existsSync(memoryMd)) files.push(memoryMd);
  const memDir = paths.memoryDir();
  if (fs.existsSync(memDir)) {
    for (const f of fs.readdirSync(memDir)) {
      if (/^\d{4}-\d{2}-\d{2}(-.*)?\.md$/.test(f)) files.push(path.join(memDir, f));
    }
  }

  for (const file of files) {
    const rel = path.relative(ws, file).split(path.sep).join("/");
    const isDaily = rel.startsWith("memory/");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    // Split into paragraph blocks, tracking line numbers.
    let cur: string[] = [];
    let start = 1;
    const flush = (endLine: number) => {
      const text = cur.join("\n").trim();
      if (text) blocks.push({ file, rel, startLine: start, endLine, text, isDaily });
      cur = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") {
        if (cur.length) flush(i);
        start = i + 2;
      } else {
        if (cur.length === 0) start = i + 1;
        cur.push(line);
      }
    }
    if (cur.length) flush(lines.length);
  }
  return blocks;
}

function score(queryTokens: string[], block: Block): number {
  if (queryTokens.length === 0) return 0;
  const uniqueQ = [...new Set(queryTokens)];
  const blockSet = new Set(tokenize(block.text));
  let matched = 0;
  for (const t of uniqueQ) if (blockSet.has(t)) matched++;
  return matched / uniqueQ.length;
}

export const memorySearchTool: Tool = {
  name: "memory_search",
  description:
    "Search your memory (MEMORY.md + daily notes in memory/) for relevant past facts, " +
    "decisions, and preferences. ALWAYS run this before answering questions about prior " +
    "conversations, the user, or ongoing work. Returns ranked excerpts with file locations.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for." },
      maxResults: { type: "number", description: "Max results (default 5)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(args) {
    const query = String(args.query ?? "").trim();
    if (!query) return "ERROR: empty query.";
    const max = Math.max(1, Math.min(10, Number(args.maxResults ?? 5)));
    const qTokens = tokenize(query);

    const ranked = collectBlocks()
      .map((b) => ({ b, s: score(qTokens, b) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, max);

    if (ranked.length === 0) {
      return `No memory matched "${query}". You may not have notes on this yet — consider writing some to memory/ when you learn something durable.`;
    }

    const out: string[] = [`Found ${ranked.length} memory result(s) for "${query}":`, ""];
    for (const { b, s } of ranked) {
      const excerpt = b.text.length > 600 ? b.text.slice(0, 600) + " …" : b.text;
      out.push(`[score ${s.toFixed(2)}] ${b.rel}:${b.startLine}-${b.endLine}`);
      out.push(excerpt, "");
      if (b.isDaily) {
        recordRecall({
          snippet: b.text.slice(0, 600),
          source: `${b.rel}:${b.startLine}-${b.endLine}`,
          score: s,
          query,
        });
      }
    }
    return out.join("\n").trim();
  },
};

export const memoryGetTool: Tool = {
  name: "memory_get",
  description: "Read an exact excerpt from a memory file by path and optional line range.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "e.g. MEMORY.md or memory/2026-07-10.md" },
      start: { type: "number" },
      end: { type: "number" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const rel = String(args.path ?? "");
    let file: string;
    try {
      file = resolveInside(ctx.workspaceDir, rel);
    } catch {
      return "ERROR: path outside workspace.";
    }
    if (!fs.existsSync(file)) return `ERROR: not found: ${rel}`;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const start = Math.max(1, Number(args.start ?? 1));
    const end = Math.min(lines.length, Number(args.end ?? Math.min(lines.length, start + 200)));
    return lines.slice(start - 1, end).join("\n");
  },
};

export const MEMORY_TOOLS: Tool[] = [memorySearchTool, memoryGetTool];
