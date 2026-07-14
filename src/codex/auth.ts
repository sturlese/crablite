// Codex (ChatGPT) OAuth — the ONLY model auth crablite implements.
//
// Ported closely from OpenClaw's openai-codex-device-code.ts and
// openai-codex-auth-identity.ts. Two login paths:
//   1. Device code (best for headless/Docker) — if the server enables it.
//   2. PKCE with manual code paste — always works; you open a URL anywhere,
//      authorize, and paste the resulting `code` back.
//
// Tokens live in ~/.crablite/auth/codex.json (0600). Access tokens are short
// lived JWTs; we refresh when within 5 minutes of expiry.

import crypto from "node:crypto";
import fs from "node:fs";
import { paths, writeSecretFile } from "../paths.js";
import { USER_AGENT, ORIGINATOR } from "../version.js";
import { log } from "../logger.js";

const AUTH_BASE = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CALLBACK = `${AUTH_BASE}/deviceauth/callback`;
const PKCE_REDIRECT = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const DEVICE_DEFAULT_INTERVAL_MS = 5_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

export type CodexCredential = {
  version: 1;
  access: string;
  refresh: string;
  expires: number; // epoch ms
  accountId?: string;
  email?: string;
  planType?: string;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function readCredential(): CodexCredential | null {
  const file = paths.codexAuthFile();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CodexCredential;
    if (!parsed.access || !parsed.refresh) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCredential(cred: CodexCredential): void {
  writeSecretFile(paths.codexAuthFile(), JSON.stringify(cred, null, 2));
}

export function isLoggedIn(): boolean {
  return readCredential() !== null;
}

// ---------------------------------------------------------------------------
// JWT identity (base64url-decode the access token payload)
// ---------------------------------------------------------------------------

function decodeJwtPayload(access: string): Record<string, any> | null {
  const parts = access.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function identityFrom(access: string): Pick<CodexCredential, "accountId" | "email" | "planType"> {
  const payload = decodeJwtPayload(access);
  const auth = payload?.["https://api.openai.com/auth"] ?? {};
  const profile = payload?.["https://api.openai.com/profile"] ?? {};
  return {
    accountId: str(auth.chatgpt_account_id),
    email: str(profile.email),
    planType: str(auth.chatgpt_plan_type),
  };
}

function expiryFrom(access: string): number | undefined {
  const exp = decodeJwtPayload(access)?.exp;
  return typeof exp === "number" && exp > 0 ? exp * 1000 : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function headers(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    originator: ORIGINATOR,
    "User-Agent": USER_AGENT,
  };
}

function buildCredential(tokens: {
  access: string;
  refresh: string;
  expiresInMs?: number;
}): CodexCredential {
  const expires = tokens.expiresInMs
    ? Date.now() + tokens.expiresInMs
    : (expiryFrom(tokens.access) ?? Date.now() + 45 * 60_000);
  return {
    version: 1,
    access: tokens.access,
    refresh: tokens.refresh,
    expires,
    ...identityFrom(tokens.access),
  };
}

// ---------------------------------------------------------------------------
// Device-code flow
// ---------------------------------------------------------------------------

export type VerificationPrompt = { verificationUrl: string; userCode: string };

async function requestDeviceCode(): Promise<{
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  verificationUrl: string;
}> {
  const res = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: headers("application/json"),
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) throw new DeviceCodeUnavailable();
    throw new Error(`Device code request failed: HTTP ${res.status} ${text}`);
  }
  const body = safeJson(text);
  const deviceAuthId = str(body?.device_auth_id);
  const userCode = str(body?.user_code) ?? str(body?.usercode);
  if (!deviceAuthId || !userCode) throw new Error("Device code response missing fields.");
  const interval =
    typeof body?.interval === "number" ? body.interval * 1000 : DEVICE_DEFAULT_INTERVAL_MS;
  return {
    deviceAuthId,
    userCode,
    intervalMs: interval,
    verificationUrl: `${AUTH_BASE}/codex/device`,
  };
}

async function pollDeviceCode(
  deviceAuthId: string,
  userCode: string,
  intervalMs: number,
): Promise<{ code: string; verifier: string }> {
  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: headers("application/json"),
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    const text = await res.text();
    if (res.ok) {
      const body = safeJson(text);
      const code = str(body?.authorization_code);
      const verifier = str(body?.code_verifier);
      if (!code || !verifier) throw new Error("Device authorization missing exchange code.");
      return { code, verifier };
    }
    if (res.status === 403 || res.status === 404) {
      await sleep(Math.min(Math.max(intervalMs, 1_000), Math.max(0, deadline - Date.now())));
      continue;
    }
    throw new Error(`Device authorization failed: HTTP ${res.status} ${text}`);
  }
  throw new Error("Device authorization timed out after 15 minutes.");
}

class DeviceCodeUnavailable extends Error {
  constructor() {
    super("Device code login is not enabled for this account.");
  }
}

// ---------------------------------------------------------------------------
// PKCE (manual paste) flow
// ---------------------------------------------------------------------------

function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge, state };
}

function buildAuthorizeUrl(challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: PKCE_REDIRECT,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "login",
  });
  return `${AUTH_BASE}/oauth/authorize?${q.toString()}`;
}

/** Extract the `code` from a pasted redirect URL or a bare code. */
export function extractAuthCode(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;
  if (trimmed.includes("code=")) {
    try {
      const url = new URL(
        trimmed.includes("://") ? trimmed : `http://x/?${trimmed.replace(/^\?/, "")}`,
      );
      const code = url.searchParams.get("code");
      if (code) return code;
    } catch {
      /* fall through */
    }
  }
  return trimmed;
}

/** Pull a query param (e.g. `state`) from a pasted redirect URL, if present. */
function extractParam(pasted: string, name: string): string | null {
  const trimmed = pasted.trim();
  if (!trimmed.includes(`${name}=`)) return null;
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `http://x/?${trimmed.replace(/^\?/, "")}`,
    );
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token exchange & refresh
// ---------------------------------------------------------------------------

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<CodexCredential> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: headers("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status} ${text}`);
  const body = safeJson(text);
  const access = str(body?.access_token);
  const refresh = str(body?.refresh_token);
  if (!access || !refresh) throw new Error("Token exchange did not return tokens.");
  const expiresInMs = typeof body?.expires_in === "number" ? body.expires_in * 1000 : undefined;
  return buildCredential({ access, refresh, expiresInMs });
}

async function refreshCredential(cred: CodexCredential): Promise<CodexCredential> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: headers("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: cred.refresh,
      scope: SCOPE,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status} ${text}`);
  const body = safeJson(text);
  const access = str(body?.access_token);
  if (!access) throw new Error("Token refresh did not return an access token.");
  const refresh = str(body?.refresh_token) ?? cred.refresh; // some servers omit a new refresh token
  const expiresInMs = typeof body?.expires_in === "number" ? body.expires_in * 1000 : undefined;
  const next = buildCredential({ access, refresh, expiresInMs });
  // A refreshed access token may not re-embed the profile/auth claims; keep the
  // prior identity rather than nulling it — same reasoning as the refresh-token
  // fallback above. accountId backs the required ChatGPT-Account-Id header.
  next.accountId ??= cred.accountId;
  next.email ??= cred.email;
  next.planType ??= cred.planType;
  writeCredential(next);
  return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Interactive login. `prompt` shows the verification instructions to the user;
 * `readLine` collects a pasted code (only used by the PKCE fallback).
 */
export async function login(io: {
  prompt: (msg: string) => void;
  onVerification: (p: VerificationPrompt) => void;
  readLine: (question: string) => Promise<string>;
}): Promise<CodexCredential> {
  // 1) Try the device-code flow (nicest for headless).
  try {
    io.prompt("Requesting device code from OpenAI…");
    const device = await requestDeviceCode();
    io.onVerification({ verificationUrl: device.verificationUrl, userCode: device.userCode });
    io.prompt("Waiting for you to authorize…");
    const { code, verifier } = await pollDeviceCode(
      device.deviceAuthId,
      device.userCode,
      device.intervalMs,
    );
    const cred = await exchangeCode(code, verifier, DEVICE_CALLBACK);
    writeCredential(cred);
    return cred;
  } catch (err) {
    if (!(err instanceof DeviceCodeUnavailable)) throw err;
    log.info("Device-code login unavailable; falling back to browser (PKCE) login.");
  }

  // 2) PKCE with manual paste.
  const { verifier, challenge, state } = pkce();
  const url = buildAuthorizeUrl(challenge, state);
  io.onVerification({ verificationUrl: url, userCode: "(sign in, then copy the redirected URL)" });
  io.prompt(
    "Open the URL above in a browser, sign in, and approve. Your browser will try to\n" +
      "redirect to http://localhost:1455/... — copy that whole URL (or just the `code`)\n" +
      "from the address bar and paste it here.",
  );
  const pasted = await io.readLine("Paste the redirect URL or code: ");
  const returnedState = extractParam(pasted, "state");
  if (returnedState && returnedState !== state) {
    throw new Error("OAuth state mismatch — aborting (possible CSRF). Start the login again.");
  }
  const code = extractAuthCode(pasted);
  if (!code) throw new Error("No authorization code was provided.");
  const cred = await exchangeCode(code, verifier, PKCE_REDIRECT);
  writeCredential(cred);
  return cred;
}

// Single-flight refresh: concurrent turns near the expiry margin must not issue
// parallel refresh_token grants (the server may rotate the refresh token and
// invalidate the loser).
let refreshInFlight: Promise<CodexCredential> | null = null;

/** Return a valid access token, refreshing if within the expiry margin. */
export async function getAccessToken(): Promise<{ access: string; accountId?: string }> {
  let cred = readCredential();
  if (!cred) throw new Error("Not logged in. Run `crablite login`.");
  if (cred.expires - Date.now() <= REFRESH_MARGIN_MS) {
    if (!refreshInFlight) {
      refreshInFlight = refreshCredential(cred).finally(() => {
        refreshInFlight = null;
      });
    }
    cred = await refreshInFlight;
  }
  return { access: cred.access, accountId: cred.accountId };
}

export function authStatus(): {
  loggedIn: boolean;
  email?: string;
  planType?: string;
  expiresInMin?: number;
} {
  const cred = readCredential();
  if (!cred) return { loggedIn: false };
  return {
    loggedIn: true,
    email: cred.email,
    planType: cred.planType,
    expiresInMin: Math.round((cred.expires - Date.now()) / 60_000),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
