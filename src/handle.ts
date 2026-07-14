// The shared inbound seam. Both channels funnel messages here: admission
// (allowlist + group mention gating) → dedupe → per-chat debounce → serialized
// runTurn → deliver reply (unless NO_REPLY). Mirrors OpenClaw's auto-reply.
//
// Per-chat serialization uses the shared withLock(chatId) so proactive turns
// (heartbeat/reminders) can never write the same session concurrently.

import { loadConfig } from "./config.js";
import { runTurn } from "./agent/runner.js";
import { sessionKeyFor } from "./session/store.js";
import { withLock } from "./util/lock.js";
import { log } from "./logger.js";
import type { InboundMessage } from "./channels/types.js";

type ChatState = { pending: InboundMessage[]; timer?: NodeJS.Timeout };

export function createInboundHandler(channelId: string): (m: InboundMessage) => Promise<void> {
  const cfg = loadConfig();
  const chats = new Map<string, ChatState>();
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  // Startup admission posture warning.
  if (cfg.allowFrom.length === 0) {
    log.warn(
      "No allowed senders configured (allowFrom is empty) — the agent will IGNORE all inbound " +
        "messages. Set CRABLITE_ALLOW_FROM to your own number(s) to enable it.",
    );
  } else if (cfg.allowFrom.includes("*")) {
    log.warn(
      'SECURITY: allowFrom is "*" — ANY sender who reaches this number can drive the agent ' +
        "(shell, email, files). Set CRABLITE_ALLOW_FROM to your own number(s).",
    );
  }

  function remember(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > 1000) {
      const old = seenOrder.shift();
      if (old) seen.delete(old);
    }
    return true;
  }

  function admit(m: InboundMessage): boolean {
    if (
      m.chatType === "group" &&
      cfg.requireMentionInGroups &&
      !isMentioned(m.text, cfg.agentName)
    ) {
      return false;
    }
    if (cfg.allowFrom.length === 0) return false; // fail-closed
    if (cfg.allowFrom.includes("*")) return true; // explicit opt-in (warned above)
    const digits = m.senderId.replace(/\D/g, "");
    return cfg.allowFrom.some(
      (a) => a === m.senderId || (digits.length > 0 && a.replace(/\D/g, "") === digits),
    );
  }

  function flush(chatId: string): void {
    const st = chats.get(chatId);
    if (!st || st.pending.length === 0) return;
    const batch = st.pending;
    if (st.timer) clearTimeout(st.timer);
    chats.delete(chatId); // evict; a new message recreates it. withLock owns ordering.

    const last = batch[batch.length - 1]!;
    const joined = batch
      .map((b) => b.text)
      .join("\n")
      .trim();
    const media = batch.flatMap((b) => b.media ?? []);
    void withLock(chatId, () => process(channelId, chatId, joined, media, last)).catch((err) =>
      log.error("turn failed", err instanceof Error ? err.message : String(err)),
    );
  }

  return async function onInbound(m: InboundMessage): Promise<void> {
    if (!m.text.trim() && !m.media?.length) return; // allow media-only messages
    if (!remember(`${m.chatId}:${m.id}`)) return; // dedupe
    if (!admit(m)) {
      log.debug(`Ignored message from ${m.senderId} in ${m.chatId} (not admitted).`);
      return;
    }
    let st = chats.get(m.chatId);
    if (!st) {
      st = { pending: [] };
      chats.set(m.chatId, st);
    }
    st.pending.push(m);
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => flush(m.chatId), Math.max(0, cfg.debounceMs));
  };
}

async function process(
  channelId: string,
  chatId: string,
  text: string,
  media: InboundMessage["media"],
  last: InboundMessage,
): Promise<void> {
  const sessionKey = sessionKeyFor(channelId, last.chatType, chatId);
  try {
    const result = await runTurn({
      sessionKey,
      userText: text,
      media,
      channel: channelId,
      chatType: last.chatType,
      chatId,
      chatReply: async (t: string) => {
        await last.reply(t);
      },
      chatSendFile: last.sendFile ? async (f) => last.sendFile!(f) : undefined,
    });
    if (!result.silent && result.replyText) {
      await last.reply(result.replyText);
    }
  } catch (err) {
    log.error("Agent turn error:", err instanceof Error ? err.message : String(err));
    try {
      await last.reply("⚠️ Sorry — I hit an error handling that. Please try again.");
    } catch {
      /* ignore delivery failure */
    }
  }
}

/** Word-boundary mention match (so "crab" inside another word doesn't trigger). */
function isMentioned(text: string, agentName: string): boolean {
  const name = agentName.trim();
  if (!name) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])@?${escapeRegExp(name)}([^\\p{L}\\p{N}]|$)`, "iu");
  return re.test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
