// Resolves the on-disk layout of crablite state. Mirrors OpenClaw's ~/.openclaw
// philosophy, collapsed to a single agent.
//
//   ~/.crablite/
//     config.json
//     auth/codex.json          model auth (0600)
//     auth/whatsapp/           baileys multi-file auth
//     workspace/               THE MEMORY (all Markdown, user-editable)
//       AGENTS.md SOUL.md IDENTITY.md USER.md MEMORY.md DREAMS.md
//       memory/YYYY-MM-DD.md   daily notes + .recall.json
//       skills/                user-dropped skills
//     sessions/                sessions.json + <sessionId>.jsonl
//     reminders.json           one-shot commitments (heartbeat-delivered)
//     routines.json            recurring routines (heartbeat-run)
//     logs/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function stateDir(): string {
  const override = process.env.CRABLITE_STATE_DIR?.trim();
  return override ? path.resolve(expandHome(override)) : path.join(os.homedir(), ".crablite");
}

export function configPath(): string {
  const override = process.env.CRABLITE_CONFIG_PATH?.trim();
  return override ? path.resolve(expandHome(override)) : path.join(stateDir(), "config.json");
}

export const paths = {
  state: stateDir,
  config: configPath,
  authDir: () => path.join(stateDir(), "auth"),
  codexAuthFile: () => path.join(stateDir(), "auth", "codex.json"),
  whatsappAuthDir: () => path.join(stateDir(), "auth", "whatsapp"),
  workspace: () => path.join(stateDir(), "workspace"),
  memoryDir: () => path.join(stateDir(), "workspace", "memory"),
  recallFile: () => path.join(stateDir(), "workspace", "memory", ".recall.json"),
  skillsDir: () => path.join(stateDir(), "workspace", "skills"),
  sessionsDir: () => path.join(stateDir(), "sessions"),
  sessionsIndex: () => path.join(stateDir(), "sessions", "sessions.json"),
  logsDir: () => path.join(stateDir(), "logs"),
  remindersFile: () => path.join(stateDir(), "reminders.json"),
  routinesFile: () => path.join(stateDir(), "routines.json"),
  heartbeatFile: () => path.join(stateDir(), "workspace", "HEARTBEAT.md"),
};

/** Create a directory (recursively) with owner-only permissions. */
export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

/** Ensure the base state directories exist. */
export function ensureStateDirs(): void {
  for (const dir of [
    stateDir(),
    paths.authDir(),
    paths.workspace(),
    paths.memoryDir(),
    paths.skillsDir(),
    paths.sessionsDir(),
    paths.logsDir(),
  ]) {
    ensureDir(dir);
  }
}

/** Write a file with owner-only permissions (for secrets). */
export function writeSecretFile(file: string, content: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

/** Atomically write JSON (tmp + rename) with owner-only permissions by default. */
export function writeJsonFileAtomic(file: string, obj: unknown, mode = 0o600): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* best effort */
  }
}

/** True if `abs` is `root` or lives under it (with a real path-separator boundary). */
export function isInside(root: string, abs: string): boolean {
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

/** Resolve `p` (relative to `root`) and require it stays inside `root`, else throw. */
export function resolveInside(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  if (!isInside(root, abs)) throw new Error(`Path is outside the allowed directory: ${p}`);
  return abs;
}

/**
 * Readable roots for the `read` tool: the workspace (memory, user skills) plus
 * the bundled skills dir (so the model can open a SKILL.md at its absolute
 * `<location>`). Anything else — e.g. the auth tokens — is refused.
 */
export function resolveReadable(workspaceDir: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspaceDir, p);
  if (isInside(workspaceDir, abs) || isInside(bundledSkillsDir(), abs)) return abs;
  throw new Error(`Path is outside the readable roots (workspace or skills): ${p}`);
}

/** Bundled resources shipped with the package (skills/, workspace-template/). */
export function packageRoot(): string {
  // src/paths.ts -> project root is one level up from src/
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
}

export function bundledSkillsDir(): string {
  return path.join(packageRoot(), "skills");
}

export function workspaceTemplateDir(): string {
  return path.join(packageRoot(), "workspace-template");
}
