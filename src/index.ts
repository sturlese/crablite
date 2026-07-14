// crablite CLI entry point.
//
//   crablite login       — authenticate with Codex (ChatGPT) OAuth
//   crablite chat         — talk to the agent in the terminal (dev/debug)
//   crablite whatsapp     — run on WhatsApp (default; also `crablite start`)
//   crablite dream        — run the self-learning promotion once
//   crablite doctor       — show status (auth, gog, workspace, config)

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureStateDirs, paths } from "./paths.js";
import { loadConfig } from "./config.js";
import { seedWorkspace } from "./memory/workspace.js";
import { login, authStatus, isLoggedIn } from "./codex/auth.js";
import { runCliChat, runCliOnce } from "./channels/cli.js";
import { WhatsAppChannel } from "./channels/whatsapp.js";
import { createInboundHandler } from "./handle.js";
import { startDreamingScheduler } from "./dreaming-cron.js";
import { startHeartbeat } from "./heartbeat.js";
import { runDreaming } from "./memory/dreaming.js";
import { loadSkills } from "./skills/loader.js";
import { hasBinary } from "./skills/loader.js";
import { pendingReminders } from "./agent/reminders.js";
import { allRoutines } from "./agent/routines.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "chat":
    case "terminal":
      await cmdChat(rest);
      break;
    case undefined:
    case "whatsapp":
    case "start":
      await cmdWhatsApp();
      break;
    case "dream":
      await cmdDream();
      break;
    case "doctor":
      cmdDoctor();
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      log.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

async function cmdLogin(): Promise<void> {
  ensureStateDirs();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const cred = await login({
      prompt: (msg) => process.stdout.write(`\n${msg}\n`),
      onVerification: (p) => {
        process.stdout.write(`\n──────────────────────────────────────────────\n`);
        process.stdout.write(`Open:  ${p.verificationUrl}\n`);
        process.stdout.write(`Code:  ${p.userCode}\n`);
        process.stdout.write(`──────────────────────────────────────────────\n`);
      },
      readLine: (q) => rl.question(q),
    });
    process.stdout.write(
      `\n✅ Logged in${cred.email ? ` as ${cred.email}` : ""}${cred.planType ? ` (${cred.planType})` : ""}.\n`,
    );
  } catch (err) {
    process.stdout.write(
      `\n❌ Login failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  } finally {
    rl.close();
  }
}

async function cmdChat(rest: string[]): Promise<void> {
  requireLogin();
  ensureStateDirs();
  seedWorkspace();
  const onceIdx = rest.indexOf("--once");
  if (onceIdx !== -1) {
    const text = rest
      .slice(onceIdx + 1)
      .join(" ")
      .trim();
    if (!text) {
      log.error('Usage: crablite chat --once "your message"');
      process.exit(1);
    }
    await runCliOnce(text);
    return;
  }
  await runCliChat();
}

async function cmdWhatsApp(): Promise<void> {
  requireLogin();
  ensureStateDirs();
  seedWorkspace();
  const cfg = loadConfig();
  log.info(`Starting crablite on WhatsApp as "${cfg.agentName}" (model ${cfg.model}).`);
  const channel = new WhatsAppChannel();
  const handler = createInboundHandler("whatsapp");
  await channel.start(handler);
  startDreamingScheduler();
  startHeartbeat(channel);
  // Stay alive (socket + schedulers keep the event loop busy).
}

async function cmdDream(): Promise<void> {
  // Promotion itself needs no model; only the diary reflection does (best-effort).
  ensureStateDirs();
  seedWorkspace();
  const cfg = loadConfig();
  const res = await runDreaming(cfg.model);
  process.stdout.write(
    res.promoted
      ? `🌙 Promoted ${res.promoted} memory item(s) into MEMORY.md (skipped ${res.skipped}). See DREAMS.md.\n`
      : `🌙 Nothing crossed the promotion threshold (checked, skipped ${res.skipped}).\n`,
  );
  for (const d of res.details) process.stdout.write(`   • ${d}\n`);
}

function cmdDoctor(): void {
  ensureStateDirs();
  seedWorkspace();
  const cfg = loadConfig();
  const auth = authStatus();
  const skills = loadSkills();
  process.stdout.write("🦀 crablite doctor\n\n");
  process.stdout.write(`State dir:   ${paths.state()}\n`);
  process.stdout.write(`Workspace:   ${paths.workspace()}\n`);
  process.stdout.write(`Model:       ${cfg.model}\n`);
  process.stdout.write(`Agent name:  ${cfg.agentName}\n`);
  process.stdout.write(`Allow from:  ${cfg.allowFrom.join(", ")}\n`);
  process.stdout.write(`Dreaming:    ${cfg.dreaming ? `on (≈${cfg.dreamHour}:00)` : "off"}\n`);
  process.stdout.write(
    `Codex auth:  ${auth.loggedIn ? `✅ ${auth.email ?? "logged in"}${auth.planType ? ` (${auth.planType})` : ""}, token ~${auth.expiresInMin}min` : "❌ not logged in — run `crablite login`"}\n`,
  );
  process.stdout.write(
    `Schedules:   ${pendingReminders().length} reminder(s) pending, ${allRoutines().length} routine(s)\n`,
  );
  process.stdout.write(
    `gog (Google): ${hasBinary("gog") ? "✅ installed" : "❌ not found (Gmail/Sheets skill will be hidden)"}\n`,
  );
  process.stdout.write(
    `Skills:      ${skills.filter((s) => s.eligible).length} eligible / ${skills.length} found\n`,
  );
  for (const s of skills) {
    process.stdout.write(
      `   ${s.eligible ? "✅" : "⏸ "} ${s.name}${s.requiresBins.length ? ` (needs: ${s.requiresBins.join(",")})` : ""}\n`,
    );
  }
}

function requireLogin(): void {
  if (!isLoggedIn()) {
    process.stdout.write(
      "❌ Not logged in. Run `crablite login` first (needs a ChatGPT/Codex account).\n",
    );
    process.exit(1);
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "🦀 crablite — a lightweight OpenClaw",
      "",
      "Usage: crablite <command>",
      "",
      "  login       Authenticate with Codex (ChatGPT) OAuth",
      "  chat        Talk to the agent in your terminal (dev/debug)",
      '  chat --once "msg"   Run a single message and exit',
      "  whatsapp    Run on WhatsApp (default). Alias: start",
      "  dream       Run the self-learning promotion once",
      "  doctor      Show status (auth, gog, workspace, config)",
      "  help        Show this help",
      "",
    ].join("\n") + "\n",
  );
}

main().catch((err) => {
  log.error("Fatal:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
