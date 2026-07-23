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
  // URL hostnames for IPv6 literals keep their brackets (new URL("http://[::1]/")
  // .hostname === "[::1]"); net.isIP rejects the bracketed form, so strip them
  // before the IP checks — otherwise every IPv6 literal fell through to dns.lookup
  // and failed, and private v6 literals were only blocked by that accidental failure.
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked private address: ${host}`);
    return;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new Error(`Cannot resolve host: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address))
      throw new Error(`Blocked private address for ${host}: ${a.address}`);
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
  if (v !== 6) return false;
  // Normalize to eight numeric groups and range-check, rather than matching string
  // prefixes: an IPv6 address has many spellings (compressed, expanded, hex- or
  // dotted-mapped) and prefix heuristics missed several (e.g. ::ffff:7f00:1 is
  // 127.0.0.1, and 0:0:0:0:0:0:0:1 is loopback).
  const g = ipv6Groups(ip.toLowerCase());
  if (!g) return true; // valid per net.isIP but unparseable here — fail closed
  if (g.every((n) => n === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1 loopback
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (g[0] >= 0xfc00 && g[0] <= 0xfdff) return true; // fc00::/7 ULA
  // IPv4-mapped ::ffff:0:0/96 — validate the embedded IPv4 in any spelling.
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return isPrivateIp(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  return false;
}

type V6Groups = [number, number, number, number, number, number, number, number];

/**
 * Expand a valid IPv6 string to its eight 16-bit groups, resolving `::` and any
 * trailing embedded IPv4 (`::ffff:1.2.3.4`). Returns null if it can't be parsed —
 * callers treat null as private (fail closed). `net.isIP` has already confirmed
 * the input is a valid v6 before this runs.
 */
function ipv6Groups(ip: string): V6Groups | null {
  let s = ip;
  // Fold a dotted IPv4 tail into two hex groups so the rest is pure hextets.
  const dotted = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)?.[1];
  if (dotted) {
    const o = dotted.split(".").map(Number) as [number, number, number, number];
    if (o.some((n) => n > 255)) return null;
    s =
      s.slice(0, -dotted.length) +
      `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null; // at most one "::"
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let parts: string[];
  if (tail === null) {
    parts = head; // no "::" — must already be all eight groups
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // "::" must stand in for at least one group
    parts = [...head, ...Array(fill).fill("0"), ...tail];
  }
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? Number.parseInt(p, 16) : -1));
  return nums.some((n) => n < 0) ? null : (nums as V6Groups);
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
