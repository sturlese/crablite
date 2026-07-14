// runTurn — the high-level entry both channels call. Mirrors OpenClaw's
// getReplyFromConfig → runEmbeddedPiAgent, collapsed: load session → build
// prompt + tools → (flush before context is dropped) → run the loop → persist.

import { paths } from "../paths.js";
import { loadConfig } from "../config.js";
import {
  loadSession,
  appendItems,
  resetSession,
  getFlushedChars,
  setFlushedChars,
  type SessionKey,
} from "../session/store.js";
import {
  userItem,
  userItemWithParts,
  imagePart,
  type ContentPart,
  type ResponseItem,
} from "../codex/responses.js";
import { CORE_TOOLS } from "./tools.js";
import type { Tool } from "./tool.js";
import { MEMORY_TOOLS } from "../memory/search.js";
import { makeSpawnTool } from "./subagent.js";
import { scheduleReminderTool } from "./reminders.js";
import { SCHEDULE_TOOLS } from "./schedule-tools.js";
import { runAgentLoop } from "./loop.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadSkills, formatSkillCatalog } from "../skills/loader.js";
import { loadProjectContext, loadRecentDailyNotes } from "../memory/workspace.js";
import { transcribeAudio } from "../media/stt.js";
import { saveInboundDocument, formatSize } from "../media/files.js";
import type { InboundMedia, OutboundFile } from "../channels/types.js";
import {
  estimateChars,
  FLUSH_TRIGGER_CHARS,
  FLUSH_MIN_GROWTH_CHARS,
  pruneForContext,
} from "./prune.js";
import { runMemoryFlush } from "../memory/flush.js";
import { runDreaming } from "../memory/dreaming.js";
import { log } from "../logger.js";

export type TurnResult = { replyText: string; silent: boolean };

export async function runTurn(params: {
  sessionKey: SessionKey;
  userText: string;
  channel: string;
  chatType: "direct" | "group";
  chatId?: string;
  /** Display name of the person in this chat (direct chats), for the prompt. */
  senderName?: string;
  media?: InboundMedia[];
  chatReply: (text: string) => Promise<void>;
  chatSendFile?: (file: OutboundFile) => Promise<void>;
  signal?: AbortSignal;
}): Promise<TurnResult> {
  const cfg = loadConfig();

  // Lightweight slash commands (text-only messages).
  if (!params.media?.length) {
    const slash = await handleSlashCommand(params.userText.trim(), params.sessionKey, cfg.model);
    if (slash) return slash;
  }

  const session = loadSession(params.sessionKey);
  const isFresh = session.items.length === 0;

  // Flush durable facts to daily notes before old context gets dropped. Throttle:
  // only after the transcript has grown meaningfully since the last flush, so we
  // don't spend an extra model call every single turn once we're over the line.
  const chars = estimateChars(session.items);
  if (
    chars > FLUSH_TRIGGER_CHARS &&
    chars - getFlushedChars(params.sessionKey) > FLUSH_MIN_GROWTH_CHARS
  ) {
    await runMemoryFlush(cfg.model, pruneForContext(session.items));
    setFlushedChars(params.sessionKey, chars);
  }

  // Build the user message: text + transcribed voice notes + images. The live
  // item (this turn) carries images; the persisted item is text-only to keep the
  // transcript small (mirrors OpenClaw storing a media reference, not the bytes).
  const { liveItem, persistItem } = await buildUserMessage(params.userText, params.media);
  // Build the model input BEFORE persisting: pruneForContext returns session.items
  // itself when under budget, and appendItems mutates it in place — so appending
  // first would leak persistItem into `prior` and send this turn to the model twice.
  const prior = pruneForContext(session.items);
  const input = [...prior, liveItem];
  appendItems(session, [persistItem]);

  // Assemble tools: core + memory + reminders/routines + subagent spawning.
  const tools: Tool[] = [
    ...CORE_TOOLS,
    ...MEMORY_TOOLS,
    scheduleReminderTool,
    ...SCHEDULE_TOOLS,
    makeSpawnTool({
      model: cfg.model,
      maxDepth: cfg.maxSubagentDepth,
      idleTimeoutMs: cfg.idleTimeoutMs,
      maxRounds: cfg.maxToolRounds,
    }),
  ];

  const skills = loadSkills();
  const instructions = buildSystemPrompt({
    agentName: cfg.agentName,
    model: cfg.model,
    tools,
    skillsCatalog: formatSkillCatalog(skills),
    projectContext: loadProjectContext(),
    recentNotes: isFresh ? loadRecentDailyNotes() : undefined,
    hasMemory: true,
    channel: params.channel,
    chatType: params.chatType,
    senderName: params.senderName,
  });

  const result = await runAgentLoop({
    model: cfg.model,
    instructions,
    input,
    tools,
    ctx: {
      workspaceDir: paths.workspace(),
      depth: 0,
      chatId: params.chatId,
      chatType: params.chatType,
      chatReply: params.chatReply,
      chatSendFile: params.chatSendFile,
      signal: params.signal,
    },
    maxRounds: cfg.maxToolRounds,
    idleTimeoutMs: cfg.idleTimeoutMs,
    signal: params.signal,
  });

  appendItems(session, result.newItems);

  const reply = result.text.trim();
  const silent = reply === "" || reply === "NO_REPLY";
  return { replyText: reply, silent };
}

/** Build the model-facing and persisted user items from text + media. */
async function buildUserMessage(
  userText: string,
  media?: InboundMedia[],
): Promise<{ liveItem: ResponseItem; persistItem: ResponseItem }> {
  if (!media?.length) {
    const item = userItem(userText);
    return { liveItem: item, persistItem: item };
  }

  let text = userText;
  const imageParts: ContentPart[] = [];
  const persistNotes: string[] = [];

  for (const m of media) {
    if (m.kind === "audio") {
      const transcript = await transcribeAudio(m.data, m.mimetype);
      if (transcript) {
        text += (text ? "\n" : "") + `[voice note transcript] ${transcript}`;
        persistNotes.push(`[voice note] ${transcript}`);
      } else {
        text += (text ? "\n" : "") + "[voice note received — transcription unavailable]";
        persistNotes.push("[voice note — not transcribed]");
      }
    } else if (m.kind === "image") {
      if (m.data.length > 10 * 1024 * 1024) {
        text += (text ? "\n" : "") + "[image received — too large to process]";
        persistNotes.push("[image — too large]");
      } else {
        imageParts.push(imagePart(m.data, m.mimetype));
        persistNotes.push("[image]");
      }
    } else if (m.kind === "document") {
      let note: string;
      try {
        const rel = saveInboundDocument(m);
        note = `[document saved: ${rel} (${m.mimetype || "unknown type"}, ${formatSize(m.data.length)})]`;
      } catch {
        note = "[document received — could not be saved]";
      }
      text += (text ? "\n" : "") + note;
      persistNotes.push(note);
    } else {
      persistNotes.push(`[${m.kind}]`);
    }
  }

  const liveParts: ContentPart[] = [];
  if (text.trim()) liveParts.push({ type: "input_text", text });
  liveParts.push(...imageParts);
  if (liveParts.length === 0) liveParts.push({ type: "input_text", text: "[media message]" });

  const persistText =
    [userText, ...persistNotes].filter(Boolean).join(" ").trim() || "[media message]";
  return { liveItem: userItemWithParts(liveParts), persistItem: userItem(persistText) };
}

async function handleSlashCommand(
  text: string,
  sessionKey: SessionKey,
  model: string,
): Promise<TurnResult | null> {
  if (text === "/reset") {
    resetSession(sessionKey);
    return {
      replyText: "🦀 Started a fresh conversation. Your memory is unchanged.",
      silent: false,
    };
  }
  if (text === "/dream") {
    log.info("Manual dreaming run requested via /dream.");
    const res = await runDreaming(model);
    const summary = res.promoted
      ? `Promoted ${res.promoted} memory item(s) into MEMORY.md. See DREAMS.md.`
      : "Nothing crossed the promotion threshold this time.";
    return { replyText: `🌙 ${summary}`, silent: false };
  }
  if (text === "/help") {
    return {
      replyText:
        "Commands: /reset (new conversation), /dream (run self-learning now), /help. " +
        "Otherwise just talk to me — I remember things in files under my workspace, and I can " +
        "schedule one-shot reminders and recurring routines (ask me what's scheduled to see them).",
      silent: false,
    };
  }
  return null;
}
