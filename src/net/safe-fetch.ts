// SSRF-hardened fetch for the `web_fetch` tool. Untrusted content can instruct
// the agent to fetch a URL, so we: allow only http/https, reject private/
// loopback/link-local addresses, re-validate on each redirect, enforce a
// timeout, and cap the body size.

import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 4;

export async function safeFetchText(
  rawUrl: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const maxBytes = opts?.maxBytes ?? 2_000_000;

  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`Blocked non-http(s) URL: ${u.protocol}`);
    }
    await assertPublicHost(u.hostname);

    const controller = new AbortController();
    // One deadline for the whole hop, including the body read. Clearing the timer
    // only after readCapped (not the moment fetch resolves) is what stops a server
    // that sends headers then stalls the body from hanging forever — an unbounded
    // body read would wedge the per-chat lock and defeat the shutdown drain.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "crablite" },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc) {
          url = new URL(loc, url).toString(); // re-validated at the top of the loop
          continue;
        }
      }
      return await readCapped(res, maxBytes);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects");
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Blocked private address: ${hostname}`);
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (addrs.length === 0) throw new Error(`Cannot resolve host: ${hostname}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address))
      throw new Error(`Blocked private address for ${hostname}: ${a.address}`);
  }
}

export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const ipl = ip.toLowerCase();
  if (ipl === "::1" || ipl === "::") return true;
  // fe80::/10 link-local spans fe80–febf (2nd hextet's high nibble 8–b), not
  // just the fe80 prefix; startsWith("fe80") let fe90–febf through as "public".
  if (/^fe[89ab]/.test(ipl)) return true; // fe80::/10 link-local
  if (ipl.startsWith("fc") || ipl.startsWith("fd")) return true; // fc00::/7 ULA
  if (ipl.startsWith("::ffff:")) return isPrivateIp(ipl.slice(7)); // IPv4-mapped
  return false;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, maxBytes);
}
