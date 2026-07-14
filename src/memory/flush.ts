// Memory flush — the silent turn that runs before old messages are dropped from
// context, appending durable facts to today's daily note. This is what makes the
// learning loop work: flushed notes become searchable, get recalled, and (if
// recalled enough) get promoted into MEMORY.md by dreaming.
//
// Faithful to OpenClaw's flush-plan.ts:13-40, simplified to a single model call.

import { callModel, type ResponseItem } from "../codex/responses.js";
import { appendDailyNote } from "./workspace.js";
import { log } from "../logger.js";

const FLUSH_INSTRUCTIONS = [
  "You are compacting a conversation before its older messages are dropped from context.",
  "Extract durable, future-useful information as concise Markdown bullets:",
  "- facts about the user and their world",
  "- decisions made and their rationale",
  "- preferences and standing instructions",
  "- open tasks / commitments and their status",
  "",
  "Rules:",
  "- Output ONLY the bullets, nothing else.",
  "- If nothing is worth keeping, output exactly: NONE",
  "- Do NOT include ephemeral chit-chat, greetings, or one-off answers.",
  "- Write each bullet as a self-contained statement (it will be read without this conversation).",
].join("\n");

/** Run a flush over the given transcript items; append durable bullets to today's note. */
export async function runMemoryFlush(model: string, items: ResponseItem[]): Promise<void> {
  try {
    const result = await callModel({
      model,
      instructions: FLUSH_INSTRUCTIONS,
      input: items,
      tools: [],
      idleTimeoutMs: 60_000,
    });
    const text = result.text.trim();
    if (!text || /^none\b/i.test(text)) {
      log.debug("Memory flush: nothing durable to keep.");
      return;
    }
    const time = new Date().toISOString().slice(11, 16);
    appendDailyNote(`## Flushed from conversation (${time})\n\n${text}`);
    log.info("Memory flush: appended durable notes to today's daily file.");
  } catch (err) {
    log.warn("Memory flush failed (continuing):", err instanceof Error ? err.message : String(err));
  }
}
