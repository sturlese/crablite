// Heartbeat — the proactive loop. Two jobs:
//   1. Deliver due reminders (commitments) as natural, context-aware messages.
//   2. Optionally, a once-daily check-in guided by HEARTBEAT.md, to a configured
//      primary chat (CRABLITE_PRIMARY_CHAT) — off unless you set that.
//
// This is OpenClaw's heartbeat runner (src/infra/heartbeat-runner.ts) reduced to
// the essentials: the agent can act without waiting for a user message.

import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";
import { loadConfig } from "./config.js";
import { runTurn } from "./agent/runner.js";
import { sessionKeyFor } from "./session/store.js";
import { withLock } from "./util/lock.js";
import { dueReminders, markDelivered, type Reminder } from "./agent/reminders.js";
import { todayStamp } from "./memory/workspace.js";
import { log } from "./logger.js";

type Sender = (chatId: string, text: string) => Promise<void>;

export function startHeartbeat(channelId: string, send: Sender): void {
  // A single reminder turn can run for up to the model idle timeout (~2 min),
  // longer than the 60s interval. setInterval does not await the previous run,
  // so without this guard two ticks overlap: the second delivers a reminder the
  // first hasn't reached yet, then the first's stale snapshot delivers it again.
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      await deliverDueReminders(channelId, send);
      await maybeDailyCheckIn(channelId, send);
    } finally {
      running = false;
    }
  };
  setInterval(() => void check(), 60_000); // every minute
  setTimeout(() => void check(), 10_000); // and shortly after startup
  log.info("Heartbeat started (proactive reminders + optional daily check-in).");
}

async function deliverDueReminders(channelId: string, send: Sender): Promise<void> {
  for (const r of dueReminders()) {
    markDelivered(r.id); // mark first so a crash can't double-deliver
    try {
      await deliverReminder(channelId, r, send);
    } catch (err) {
      log.error("Reminder delivery failed:", err instanceof Error ? err.message : String(err));
      // Fall back to a plain reminder so it isn't silently lost.
      try {
        await send(r.chatId, `⏰ Reminder: ${r.text}`);
      } catch {
        /* give up */
      }
    }
  }
}

async function deliverReminder(channelId: string, r: Reminder, send: Sender): Promise<void> {
  // Serialize with any inbound turn for the same chat.
  const res = await withLock(r.chatId, () =>
    runTurn({
      sessionKey: sessionKeyFor(channelId, r.chatType, r.chatId),
      userText:
        `[Proactive reminder] Earlier you set a reminder to bring this up now: "${r.text}". ` +
        `Message the user about it naturally and concisely, in character.`,
      channel: channelId,
      chatType: r.chatType,
      chatId: r.chatId,
      chatReply: async (t) => send(r.chatId, t),
    }),
  );
  if (!res.silent && res.replyText) await send(r.chatId, res.replyText);
  else if (res.silent) await send(r.chatId, `⏰ ${r.text}`); // ensure the reminder lands
}

// --- optional daily HEARTBEAT.md check-in -----------------------------------

function lastCheckInFile(): string {
  return path.join(paths.state(), ".heartbeat-last");
}

function ranToday(): boolean {
  try {
    return fs.readFileSync(lastCheckInFile(), "utf8").trim() === todayStamp();
  } catch {
    return false;
  }
}

function markRanToday(): void {
  try {
    fs.writeFileSync(lastCheckInFile(), todayStamp());
  } catch {
    /* best effort */
  }
}

async function maybeDailyCheckIn(channelId: string, send: Sender): Promise<void> {
  const cfg = loadConfig();
  const chatId = cfg.heartbeatChat;
  if (!chatId) return; // check-ins are opt-in via CRABLITE_PRIMARY_CHAT
  const now = new Date();
  if (now.getHours() !== cfg.heartbeatHour) return;
  if (ranToday()) return;
  markRanToday();

  const guidance = readHeartbeatGuidance();
  log.info("Running daily heartbeat check-in.");
  try {
    const res = await withLock(chatId, () =>
      runTurn({
        sessionKey: sessionKeyFor(channelId, "direct", chatId),
        userText:
          `[Heartbeat] It's your scheduled check-in. Guidance:\n${guidance}\n\n` +
          `Decide if there is anything genuinely worth proactively telling the user right now ` +
          `(due follow-ups, time-sensitive facts from memory). If yes, send a brief, useful message. ` +
          `If there is nothing worth interrupting them for, reply exactly NO_REPLY.`,
        channel: channelId,
        chatType: "direct",
        chatId,
        chatReply: async (t) => send(chatId, t),
      }),
    );
    if (!res.silent && res.replyText) await send(chatId, res.replyText);
  } catch (err) {
    log.error("Heartbeat check-in failed:", err instanceof Error ? err.message : String(err));
  }
}

function readHeartbeatGuidance(): string {
  try {
    return (
      fs.readFileSync(paths.heartbeatFile(), "utf8").trim() || "(no HEARTBEAT.md guidance set)"
    );
  } catch {
    return "(no HEARTBEAT.md guidance set)";
  }
}
