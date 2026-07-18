# src/codex — model auth and transport

## Purpose

The only way crablite talks to a model. OAuth against the ChatGPT/Codex account (no API keys) and
a streaming client for the Codex Responses endpoint. If OpenAI changes the private contract, this
directory is the blast radius.

## Key entry points

| File | Role |
| --- | --- |
| `auth.ts` | `login(io)`, `getAccessToken()`, `isLoggedIn()`, `authStatus()`, `readCredential()`, `extractAuthCode()`. Device-code flow with a PKCE manual-paste fallback; single-flight refresh. |
| `responses.ts` | `callModel(params)` — POST + SSE parse. Item builders: `userItem`, `userItemWithParts`, `imagePart`, `assistantItem`, `functionCallItem`, `functionOutputItem`. Types: `ResponseItem`, `ContentPart`, `ToolSchema`, `ToolCall`. Also `CODEX_BASE_URL`. |

## Use these

- **`callModel`** for every model call — the agent loop, the memory flush, and the dreaming
  reflection all go through it. Pass `tools: []` for a plain completion.
- **The item builders**, never hand-written object literals. `ResponseItem` is a closed union that
  `prune.ts`, `store.ts` and `loop.ts` all branch on.
- **`getAccessToken()`** whenever you need a token; it refreshes within a 5-minute margin and is
  single-flight. Do not cache the result across calls.
- **`CODEX_BASE_URL`** as the base for any other Codex endpoint (this is how `media/stt.ts` reaches
  `/audio/transcriptions` with no extra key).
- **`USER_AGENT` / `ORIGINATOR`** from `../version.js` on every request to a Codex/auth endpoint.

## Avoid / anti-patterns

- Do **not** add a second model provider here. Single-provider is a design decision; a provider
  registry is exactly the OpenClaw machinery crablite drops.
- Do **not** issue parallel `refresh_token` grants. The server may rotate the refresh token and
  invalidate the loser — `getAccessToken` guards this with `refreshInFlight`. Keep it.
- Do **not** drop identity fields on refresh. A refreshed access token may not re-embed the
  profile/auth claims; `refreshCredential` preserves `accountId`/`email`/`planType` (and
  `accountId` backs the required `ChatGPT-Account-Id` header).
- Do **not** log tokens, credentials or raw auth responses. Errors surface status + a truncated
  body only.
- Do **not** write the credential file with anything but `writeSecretFile` (`0600`).
- Do **not** scatter headers. Every header and field of the private contract lives in these two
  files so a breakage is a one-file fix.
- Do **not** assume `response.failed` and `error` events nest the message the same way — both
  shapes are handled in `callModel`; keep both.

## Data & contracts

```ts
CodexCredential = { version: 1; access; refresh; expires /* epoch ms */;
                    accountId?; email?; planType? }   // ~/.crablite/auth/codex.json, 0600

ResponseItem = MessageItem | FunctionCallItem | FunctionOutputItem
ContentPart  = input_text | output_text | input_image
```

- Endpoint: `https://chatgpt.com/backend-api/codex` (`CRABLITE_CODEX_BASE_URL` overrides).
- Auth base: `https://auth.openai.com`; PKCE redirect `http://localhost:1455/auth/callback`;
  scope `openid profile email offline_access`.
- Request body pins `parallel_tool_calls: false`, `store: false`, `stream: true`,
  `tool_choice: "auto"`, `strict: false` per tool.
- Stream events consumed: `response.output_text.delta`, `response.output_item.done`
  (`function_call`), `response.failed`, `error`, `response.completed` / `[DONE]`.
- Idle timeout: the timer re-arms on every SSE event; expiry aborts the request.

## Tests

`test/auth.test.ts` (identity/expiry parsing, refresh, single-flight, `extractAuthCode`) and
`test/responses.test.ts` (item builders) + `test/responses-call.test.ts` (`callModel`: SSE parsing,
tool-call extraction, error events, idle timeout). Network is mocked; `test/helpers.ts` provides
`fakeJwt` for credential fixtures.

## Common tasks

| Task | Where |
| --- | --- |
| Model request fails with 4xx | `responses.ts` `requestHeaders` / `body`; try `CRABLITE_CODEX_BASE_URL` + `CRABLITE_MODEL` |
| A new stream event type | `responses.ts` `switch (evt.event)` |
| A new content part kind | `ContentPart` union + a builder + check `prune.ts`/`store.ts` handling |
| Login flow changes | `auth.ts` (`requestDeviceCode`/`pollDeviceCode`/`buildAuthorizeUrl`) |
| Add another Codex-backed endpoint | Build on `CODEX_BASE_URL` + `getAccessToken` (see `media/stt.ts`) |

## Notes

- The PKCE fallback validates the returned `state` when the user pastes a full redirect URL
  (CSRF guard). A bare code paste cannot be validated — that is accepted.
- OAuth constants (`CLIENT_ID`, callbacks) are ported from the OpenAI Codex CLI; they are public
  client identifiers, not secrets.
- The SSE parser handles both `\n\n` and `\r\n\r\n` separators and multi-line `data:` fields.
