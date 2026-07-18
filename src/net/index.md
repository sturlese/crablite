# src/net — SSRF-hardened fetch

## Purpose

Outbound HTTP for the `web_fetch` tool. Untrusted content can instruct the agent to fetch a URL, so
this is a security boundary, not a convenience wrapper.

## Key entry points

`safe-fetch.ts`:

| Export | Role |
| --- | --- |
| `safeFetchText(url, { timeoutMs?, maxBytes? })` | Validated fetch returning the body as text. Defaults: 15s timeout, 2 MB cap, max 4 redirects. |
| `isPrivateIp(ip)` | The address predicate (exported for testing and reuse). |

## Use these

- **`safeFetchText`** for every fetch of a model- or content-supplied URL.
- **`isPrivateIp`** if you ever need the same check elsewhere; do not re-derive the ranges.

## Avoid / anti-patterns

- Do **not** call bare `fetch()` with a URL that came from the model, a web page, a file, or a
  store. Calls to *fixed, first-party* endpoints (Codex, auth, STT) are fine and stay in their own
  modules.
- Do **not** use `redirect: "follow"`. Redirects are handled manually so **every hop is
  re-validated** — a public host redirecting to `169.254.169.254` is the classic bypass.
- Do **not** relax the address checks. Blocked: non-http(s) schemes, `0.0.0.0/8`, `10/8`,
  `127/8`, `169.254/16` (link-local/metadata), `172.16/12`, `192.168/16`, `100.64/10` (CGNAT),
  multicast/reserved (`>= 224`), `::1`, `::`, `fe80::/10` (matched as `fe[89ab]`, not just the
  `fe80` prefix), `fc00::/7`, and IPv4-mapped forms.
- Do **not** drop the body cap or the timeout — both bound a memory/bandwidth DoS.
- Do **not** treat the result as instructions. The caller (`agent/tools.ts` `web_fetch`) fences the
  output as untrusted data and the system prompt forbids following it. Keep both halves.

## Data & contracts

Returns decoded UTF-8 text, truncated to `maxBytes`. Throws on: non-http(s) scheme, unresolvable
host, any resolved address being private, or too many redirects. `User-Agent: crablite`.

DNS is resolved with `dns.lookup(host, { all: true })` and **every** returned address must be
public.

## Tests

`test/safe-fetch.test.ts` — scheme rejection, private/loopback/link-local/CGNAT/IPv6 cases via
`isPrivateIp`, redirect re-validation, and the size cap.

## Common tasks

| Task | Where |
| --- | --- |
| Block a new address range | `isPrivateIp` (+ a test case) |
| Change timeout / size defaults | `safeFetchText` defaults, or pass options from the caller |
| Add a first-party HTTP client | Its own module — do not extend this one with allowlisted hosts |

## Notes

- A TOCTOU gap remains between the DNS check and the connection (DNS rebinding). Accepted for a
  single-user personal agent; closing it needs a custom agent/socket-level check.
- `readCapped` cancels the reader as soon as the cap is hit rather than draining the response.
