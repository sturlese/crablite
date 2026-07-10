// The dev/debug channel: a readline REPL that exercises the exact same runTurn
// path as WhatsApp. This is OpenClaw's `openclaw chat` embedded backend idea.

import readline from "node:readline";
import { runTurn } from "../agent/runner.js";
import { loadConfig } from "../config.js";

const SESSION_KEY = "crablite:cli:direct:cli";

export async function runCliChat(): Promise<void> {
  const cfg = loadConfig();
  process.stdout.write(
    `🦀 crablite — chatting with ${cfg.agentName} (model: ${cfg.model}).\n` +
      `Type a message. Commands: /reset, /dream, /help. Ctrl-C or "exit" to quit.\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\nyou › " });
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === "exit" || text === "quit" || text === "/exit") break;
    await runOneTurn(cfg.agentName, text);
    rl.prompt();
  }
  rl.close();
}

/** One-shot turn (for `crablite chat --once "..."` and scripted debugging). */
export async function runCliOnce(text: string): Promise<void> {
  const cfg = loadConfig();
  await runOneTurn(cfg.agentName, text);
}

async function runOneTurn(agentName: string, text: string): Promise<void> {
  try {
    const res = await runTurn({
      sessionKey: SESSION_KEY,
      userText: text,
      channel: "cli",
      chatType: "direct",
      chatReply: async (t: string) => {
        process.stdout.write(`\n${agentName} › ${t}\n`);
      },
    });
    if (!res.silent && res.replyText) {
      process.stdout.write(`\n${agentName} › ${res.replyText}\n`);
    } else if (res.silent) {
      process.stdout.write(`\n${agentName} › (no reply)\n`);
    }
  } catch (err) {
    process.stdout.write(`\n⚠️  ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
