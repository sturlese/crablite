// Nightly self-learning scheduler. Checks periodically and runs dreaming once
// per day at the configured hour. Persists the last run day so restarts don't
// double-run.

import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";
import { loadConfig } from "./config.js";
import { runDreaming } from "./memory/dreaming.js";
import { todayStamp } from "./memory/workspace.js";
import { log } from "./logger.js";

function stateFile(): string {
  return path.join(paths.state(), ".dream-last");
}

function lastRunDay(): string | null {
  try {
    return fs.readFileSync(stateFile(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function setLastRunDay(day: string): void {
  try {
    fs.writeFileSync(stateFile(), day);
  } catch {
    /* best effort */
  }
}

export function startDreamingScheduler(): void {
  const cfg = loadConfig();
  if (!cfg.dreaming) {
    log.info("Dreaming is disabled (config.dreaming = false).");
    return;
  }

  const check = async () => {
    const now = new Date();
    if (now.getHours() !== cfg.dreamHour) return;
    const today = todayStamp();
    if (lastRunDay() === today) return;
    setLastRunDay(today);
    log.info("Running nightly dreaming…");
    try {
      await runDreaming(cfg.model);
    } catch (err) {
      log.error("Dreaming failed:", err instanceof Error ? err.message : String(err));
    }
  };

  // Check every 30 minutes (and once shortly after startup).
  setInterval(() => void check(), 30 * 60_000);
  setTimeout(() => void check(), 5_000);
  log.info(
    `Dreaming scheduled daily around ${String(cfg.dreamHour).padStart(2, "0")}:00 local time.`,
  );
}
