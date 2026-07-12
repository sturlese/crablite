import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpState, cleanup, fakeJwt } from "./helpers.js";
import { paths, writeSecretFile } from "../src/paths.js";
import { readCredential, isLoggedIn, authStatus, extractAuthCode, getAccessToken, login } from "../src/codex/auth.js";

let dir: string;
afterEach(() => {
  cleanup(dir);
  vi.unstubAllGlobals();
});

const writeCred = (c: Record<string, unknown>) => writeSecretFile(paths.codexAuthFile(), JSON.stringify(c));

describe("codex auth", () => {
  it("extractAuthCode parses a bare code and a redirect URL", () => {
    expect(extractAuthCode("abc123")).toBe("abc123");
    expect(extractAuthCode("http://localhost:1455/auth/callback?code=XYZ&state=s")).toBe("XYZ");
    expect(extractAuthCode("   ")).toBe(null);
  });

  it("reports login state and identity from the stored credential", () => {
    dir = tmpState();
    expect(isLoggedIn()).toBe(false);
    expect(authStatus().loggedIn).toBe(false);
    writeCred({ version: 1, access: "a", refresh: "r", expires: Date.now() + 3_600_000, email: "me@x.com", planType: "plus" });
    expect(isLoggedIn()).toBe(true);
    const s = authStatus();
    expect(s.loggedIn).toBe(true);
    expect(s.email).toBe("me@x.com");
    expect(s.planType).toBe("plus");
    expect(s.expiresInMin).toBeGreaterThan(50);
  });

  it("returns a still-valid token without refreshing", async () => {
    dir = tmpState();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    writeCred({ version: 1, access: "valid", refresh: "r", expires: Date.now() + 3_600_000, accountId: "acc" });
    const { access, accountId } = await getAccessToken();
    expect(access).toBe("valid");
    expect(accountId).toBe("acc");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes an expired token once, even under concurrency (single-flight)", async () => {
    dir = tmpState();
    const newAccess = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acc2" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => JSON.stringify({ access_token: newAccess, refresh_token: "r2", expires_in: 3600 }) });
    vi.stubGlobal("fetch", fetchMock);
    writeCred({ version: 1, access: "old", refresh: "r", expires: Date.now() - 1000, accountId: "acc" });

    const [a, b] = await Promise.all([getAccessToken(), getAccessToken()]);
    expect(a.access).toBe(newAccess);
    expect(b.access).toBe(newAccess);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readCredential()!.access).toBe(newAccess);
  });

  it("preserves prior identity on refresh when the new token omits its claims", async () => {
    dir = tmpState();
    // A refreshed access token whose JWT carries no auth/profile claims (valid:
    // refreshed access tokens aren't required to re-embed profile/email).
    const newAccess = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ access_token: newAccess, refresh_token: "r2", expires_in: 3600 }) }),
    );
    writeCred({ version: 1, access: "old", refresh: "r", expires: Date.now() - 1000, accountId: "acc", email: "me@x.com", planType: "plus" });

    const { accountId } = await getAccessToken();
    // The required ChatGPT-Account-Id header must survive a refresh.
    expect(accountId).toBe("acc");
    const stored = readCredential()!;
    expect(stored.email).toBe("me@x.com");
    expect(stored.planType).toBe("plus");
  });

  const jsonRes = (o: unknown) => ({ ok: true, text: async () => JSON.stringify(o) });
  const noop = () => {};

  it("device-code login exchanges tokens and persists identity", async () => {
    dir = tmpState();
    const jwt = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acc", chatgpt_plan_type: "pro" },
      "https://api.openai.com/profile": { email: "a@b.com" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("deviceauth/usercode")) return jsonRes({ device_auth_id: "d", user_code: "U", interval: 0.001 });
        if (String(url).includes("deviceauth/token")) return jsonRes({ authorization_code: "ac", code_verifier: "cv" });
        if (String(url).includes("/oauth/token")) return jsonRes({ access_token: jwt, refresh_token: "r", expires_in: 3600 });
        throw new Error("unexpected " + url);
      }),
    );
    const cred = await login({ prompt: noop, onVerification: noop, readLine: async () => "" });
    expect(cred.access).toBe(jwt);
    expect(cred.email).toBe("a@b.com");
    expect(cred.accountId).toBe("acc");
    expect(readCredential()!.access).toBe(jwt);
  });

  it("falls back to PKCE paste when device code is unavailable (404)", async () => {
    dir = tmpState();
    const jwt = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("deviceauth/usercode")) return { ok: false, status: 404, text: async () => "not enabled" };
        if (String(url).includes("/oauth/token")) return jsonRes({ access_token: jwt, refresh_token: "r", expires_in: 3600 });
        throw new Error("unexpected " + url);
      }),
    );
    const cred = await login({ prompt: noop, onVerification: noop, readLine: async () => "CODE123" });
    expect(cred.access).toBe(jwt);
  });
});
