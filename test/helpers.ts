// Shared test helpers: an isolated temp state dir per test + a fake JWT builder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache } from "../src/config.js";
import { resetSessionCache } from "../src/session/store.js";

const CRABLITE_ENV = [
  "CRABLITE_STATE_DIR",
  "CRABLITE_CONFIG_PATH",
  "CRABLITE_MODEL",
  "CRABLITE_AGENT_NAME",
  "CRABLITE_ALLOW_FROM",
  "CRABLITE_DREAMING",
  "CRABLITE_PRIMARY_CHAT",
];

/** Create a fresh temp state dir, point crablite at it, and clear stray env. */
export function tmpState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crablite-test-"));
  for (const k of CRABLITE_ENV) delete process.env[k];
  process.env.CRABLITE_STATE_DIR = dir;
  resetConfigCache();
  // SessionKey does not include the state dir — drop cached sessions so this
  // test's temp dir never observes another test's cached transcripts.
  resetSessionCache();
  return dir;
}

export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** A syntactically valid (unsigned) JWT so identity/expiry parsing can be tested. */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}
