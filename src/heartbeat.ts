// Heartbeat — the proactive loop. Three jobs:
//   1. Deliver due reminders (commitments) as natural, context-aware messages.
//   2. Run due routines (recurring standing instructions) as proactive turns.
//   3. Optionally, a once-daily check-in guided by HEARTBEAT.md, to a configured
//      primary chat (CRABLITE_PRIMARY_CHAT) — off unless you set that.
//
// This is OpenClaw's heartbeat runner (src/infra/heartbeat-runner.ts) plus its
// cron scheduler, reduced to the essentials: the agent can act without waiting
// for a user message. Reminders must always land (plain-text fallback);
// routines respect NO_REPLY — a monitoring routine that finds nothing stays
// quiet, in the spirit of OpenClaw's standing orders.

import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";
import { loadConfig } from "./config.js";
import { runTurn } from "./agent/runner.js";
import { sessionKeyFor } from "./session/store.js";
import { withTypingIndicator } from "./handle.js";
import { withLock } from "./util/lock.js";
import { dueReminders, markDelivered, type Reminder } from "./agent/reminders.js";
import { advanceRoutine, describeSchedule, dueRoutines, type Routine } from "./agent/routines.js";
import { todayStamp } from "./memory/workspace.js";
import { log } from "./logger.js";
import type { OutboundFile } from "./channels/types.js";

/** What the heartbeat needs from a channel (WhatsAppChannel satisfies it). */
export type HeartbeatChannel = {
  id: string;
  send: (chatId: string, text: string) => Promise<void>;
  sendFile?: (chatId: string, file: OutboundFile) => Promise<void>;
  sendTyping?: (chatId: string, on: boolean) => Promise<void>;
};

export function startHeartbeat(channel: HeartbeatChannel): void {
  // A single reminder turn can run for up to the model idle timeout (~2 min),
  // longer than the 60s interval. setInterval does not await the previous run,
  // so without this guard two ticks overlap: the second delivers a reminder the
  // first hasn't reached yet, then the first's stale snapshot delivers it again.
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      await deliverDueReminders(channel);
      await runDueRoutines(channel);
      await maybeDailyCheckIn(channel);
    } finally {
      running = false;
    }
  };
  setInterval(() => void check(), 60_000); // every minute
  setTimeout(() => void check(), 10_000); // and shortly after startup
  log.info("Heartbeat started (proactive reminders + optional daily check-in).");
}

async function deliverDueReminders(channel: HeartbeatChannel): Promise<void> {
  for (const r of dueReminders()) {
    markDelivered(r.id); // mark first so a crash can't double-deliver
    try {
      await deliverReminder(channel, r);
    } catch (err) {
      log.error("Reminder delivery failed:", err instanceof Error ? err.message : String(err));
      // Fall back to a plain reminder so it isn't silently lost.
      try {
        await channel.send(r.chatId, `⏰ Reminder: ${r.text}`);
      } catch {
        /* give up */
      }
    }
  }
}

async function deliverReminder(channel: HeartbeatChannel, r: Reminder): Promise<void> {
  // Serialize with any inbound turn for the same chat.
  const res = await withTypingIndicator(typingFor(channel, r.chatId), () =>
    withLock(r.chatId, () =>
      runTurn({
        sessionKey: sessionKeyFor(channel.id, r.chatType, r.chatId),
        userText:
          `[Proactive reminder] Earlier you set a reminder to bring this up now: "${r.text}". ` +
          `Message the user about it naturally and concisely, in character.`,
        channel: channel.id,
        chatType: r.chatType,
        chatId: r.chatId,
        chatReply: async (t) => channel.send(r.chatId, t),
        chatSendFile: fileSender(channel, r.chatId),
      }),
    ),
  );
  if (!res.silent && res.replyText) await channel.send(r.chatId, res.replyText);
  else if (res.silent) await channel.send(r.chatId, `⏰ ${r.text}`); // ensure the reminder lands
}

/** Bind the channel's file sender (if any) to one chat, for proactive turns. */
function fileSender(
  channel: HeartbeatChannel,
  chatId: string,
): ((file: OutboundFile) => Promise<void>) | undefined {
  const sendFile = channel.sendFile?.bind(channel);
  return sendFile ? (file) => sendFile(chatId, file) : undefined;
}

/** Bind the channel's typing indicator (if any) to one chat. */
function typingFor(
  channel: HeartbeatChannel,
  chatId: string,
): ((on: boolean) => Promise<void>) | undefined {
  const sendTyping = channel.sendTyping?.bind(channel);
  return sendTyping ? (on) => sendTyping(chatId, on) : undefined;
}

// --- recurring routines -------------------------------------------------------

async function runDueRoutines(channel: HeartbeatChannel): Promise<void> {
  for (const r of dueRoutines()) {
    advanceRoutine(r.id); // advance first so a crash skips to the next occurrence
    try {
      await runRoutine(channel, r);
    } catch (err) {
      // Unlike reminders there is no plain-text fallback: the routine will
      // fire again at its next occurrence anyway.
      log.error(`Routine [${r.id}] failed:`, err instanceof Error ? err.message : String(err));
    }
  }
}

async function runRoutine(channel: HeartbeatChannel, r: Routine): Promise<void> {
  log.info(`Running routine [${r.id}] (${describeSchedule(r.schedule)}).`);
  // Serialize with any inbound turn for the same chat.
  const res = await withTypingIndicator(typingFor(channel, r.chatId), () =>
    withLock(r.chatId, () =>
      runTurn({
        sessionKey: sessionKeyFor(channel.id, r.chatType, r.chatId),
        userText:
          `[Scheduled routine ${r.id} — ${describeSchedule(r.schedule)}] Your standing instruction: ` +
          `"${r.text}". Do it now. If it is a check and there is genuinely nothing worth telling ` +
          `the user, reply exactly NO_REPLY.`,
        channel: channel.id,
        chatType: r.chatType,
        chatId: r.chatId,
        chatReply: async (t) => channel.send(r.chatId, t),
        chatSendFile: fileSender(channel, r.chatId),
      }),
    ),
  );
  // Routines respect silence — no fallback send (see module header).
  if (!res.silent && res.replyText) await channel.send(r.chatId, res.replyText);
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

async function maybeDailyCheckIn(channel: HeartbeatChannel): Promise<void> {
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
    const res = await withTypingIndicator(typingFor(channel, chatId), () =>
      withLock(chatId, () =>
        runTurn({
          sessionKey: sessionKeyFor(channel.id, "direct", chatId),
          userText:
            `[Heartbeat] It's your scheduled check-in. Guidance:\n${guidance}\n\n` +
            `Decide if there is anything genuinely worth proactively telling the user right now ` +
            `(due follow-ups, time-sensitive facts from memory). If yes, send a brief, useful message. ` +
            `If there is nothing worth interrupting them for, reply exactly NO_REPLY.`,
          channel: channel.id,
          chatType: "direct",
          chatId,
          chatReply: async (t) => channel.send(chatId, t),
          chatSendFile: fileSender(channel, chatId),
        }),
      ),
    );
    if (!res.silent && res.replyText) await channel.send(chatId, res.replyText);
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
