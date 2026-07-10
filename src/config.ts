// Flat configuration. OpenClaw's config schema is ~930 lines; crablite needs a
// handful of keys. Config is JSON at ~/.crablite/config.json; env always wins.

import fs from "node:fs";
import { paths } from "./paths.js";
import { log } from "./logger.js";

export type Config = {
  /** Model id sent to the Codex Responses API (provider prefix stripped). */
  model: string;
  /** Display name / persona handle used in the system prompt. */
  agentName: string;
  /** Senders allowed to talk to the agent. "*" = everyone. */
  allowFrom: string[];
  /** Enable the nightly self-learning ("dreaming") promotion. */
  dreaming: boolean;
  /** Hour of day (local, 0-23) to run dreaming. */
  dreamHour: number;
  /** In groups, only respond when mentioned. */
  requireMentionInGroups: boolean;
  /** Coalesce rapid inbound messages from the same chat (ms). */
  debounceMs: number;
  /** Abort a turn if the model streams no token for this long (ms). */
  idleTimeoutMs: number;
  /** Maximum tool-call rounds in a single turn. */
  maxToolRounds: number;
  /** Maximum depth of subagent spawning. */
  maxSubagentDepth: number;
  /** Chat id for the optional daily heartbeat check-in ("" = off). */
  heartbeatChat: string;
  /** Hour of day (local) for the heartbeat check-in. */
  heartbeatHour: number;
};

const DEFAULTS: Config = {
  model: "gpt-5.5",
  agentName: "Crab",
  // Closed by default: with no senders configured the agent ignores all inbound
  // messages. Set CRABLITE_ALLOW_FROM to your own number(s). "*" is an explicit,
  // loudly-warned opt-in — it lets ANY sender drive the agent (shell, email).
  allowFrom: [],
  dreaming: true,
  dreamHour: 3,
  requireMentionInGroups: true,
  debounceMs: 0,
  idleTimeoutMs: 120_000,
  maxToolRounds: 12,
  maxSubagentDepth: 2,
  heartbeatChat: "",
  heartbeatHour: 8,
};

function parseListEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  let fromFile: Partial<Config> = {};
  const file = paths.config();
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
    } catch (err) {
      log.warn(`Could not parse ${file}; using defaults.`, String(err));
    }
  }

  const merged: Config = { ...DEFAULTS, ...fromFile };

  // Environment overrides (highest precedence).
  if (process.env.CRABLITE_MODEL) merged.model = process.env.CRABLITE_MODEL.trim();
  if (process.env.CRABLITE_AGENT_NAME) merged.agentName = process.env.CRABLITE_AGENT_NAME.trim();
  const allow = parseListEnv(process.env.CRABLITE_ALLOW_FROM);
  if (allow) merged.allowFrom = allow;
  if (process.env.CRABLITE_DREAMING) merged.dreaming = process.env.CRABLITE_DREAMING !== "0";
  if (process.env.CRABLITE_PRIMARY_CHAT) merged.heartbeatChat = process.env.CRABLITE_PRIMARY_CHAT.trim();

  // Strip a provider prefix like "openai/gpt-5.5" -> "gpt-5.5".
  if (merged.model.includes("/")) merged.model = merged.model.split("/").pop()!;

  cached = merged;
  return merged;
}

/** Test/CLI helper to force a reload after writing config. */
export function resetConfigCache(): void {
  cached = null;
}
