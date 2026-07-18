# src/channels — transports

## Purpose

Adapt a messaging transport to one small interface so the agent path is identical everywhere.
WhatsApp is the product; the CLI is the development/debug channel and exercises the same
`runTurn`.

## Key entry points

| File | Role |
| --- | --- |
| `types.ts` | **The contract**: `Channel`, `InboundMessage`, `InboundMedia`, `OutboundFile`, `ChatType`. |
| `whatsapp.ts` | `WhatsAppChannel implements Channel` — Baileys multi-device, QR link, reconnect with backoff, media download, presence/reactions/read receipts. Plus `pauseIntake()` (shutdown: stop feeding inbound while the socket stays open). Also exports `extractText` and `extractQuoted` (pure, tested). |
| `cli.ts` | `runCliChat()` (readline REPL) and `runCliOnce(text)`. Fixed session key `crablite:cli:direct:cli`. |

## Use these

- **Implement `Channel`** for a new transport, then wire it in `src/index.ts`:
  `createInboundHandler("<id>")` returns `InboundHandler = { onInbound, flushPending }` — pass
  `handler.onInbound` to `channel.start(…)` and hand the whole handler to `registerShutdown`.
  Nothing else should change.
- **Optional capability methods** (`sendFile`, `react`, `setTyping`, `markRead` on
  `InboundMessage`; `sendFile`/`sendTyping` on `Channel`) — omit them if the transport cannot do
  it. Callers all guard for absence, and the corresponding tool degrades to a helpful message.
- **`extractText` / `extractQuoted`** for any new WhatsApp message shape; they already handle the
  `documentWithCaptionMessage` wrapper and media placeholders.
- **`MAX_FILE_BYTES`** (`media/files.ts`) as the single transfer cap in both directions.

## Avoid / anti-patterns

- Do **not** call `runTurn` from a channel. Channels produce `InboundMessage`s and feed them to
  `handler.onInbound` from `handle.ts`; that is where admission and locking live.
- Do **not** add `pauseIntake` to the `Channel` interface yet. It is deliberately
  WhatsApp-specific: the CLI has no drain problem (its loop just ends), and generalizing a
  shutdown surface for one long-running transport would be speculative. Promote it to the contract
  only when a second long-running transport exists.
- Do **not** close the socket to stop intake. `pauseIntake` keeps the socket OPEN so draining turns
  can still deliver their replies; `stop()` (which also cancels a pending reconnect timer) comes
  only after the drain.
- Do **not** put admission, dedupe, mention-gating or debouncing in a channel. `handle.ts` owns all
  of it, so every transport behaves the same.
- Do **not** download media before checking the declared size. `whatsapp.ts` rejects on
  `fileLength` first and re-checks the downloaded buffer — that bound is a DoS control.
- Do **not** widen the `any` usage beyond the Baileys boundary. The untyped `any` in `whatsapp.ts`
  is a deliberate interop concession (Baileys ships CJS/ESM variants); the typed core is where the
  compiler earns its keep.
- Do **not** quote replies in direct chats. Quoting is group-only in `whatsapp.ts` (`opts`); in a
  1:1 chat it is noise.
- Do **not** process messages with `key.fromMe` or `status@broadcast` — they are filtered early.

## Data & contracts

```ts
InboundMessage = {
  id; chatId; senderId; senderName?; chatType: "direct" | "group";
  text; quotedText?; media?: InboundMedia[];
  reply(text) => { messageId };
  sendFile?(file); react?(emoji); setTyping?(on); markRead?();
}

Channel = { id; start(onInbound); send(chatId, text); sendFile(chatId, file);
            sendTyping(chatId, on); stop(); }
```

- `InboundMedia.kind`: `image | audio | video | document`. WhatsApp currently extracts
  `image`, `audio` and `document`.
- WhatsApp chat ids: `…@g.us` ⇒ group, anything else ⇒ direct. `senderId` is
  `key.participant` in groups, the chat id otherwise.
- Auth state: `~/.crablite/auth/whatsapp/` (Baileys multi-file). Deleting it forces a re-link.

## Tests

`test/whatsapp-extract.test.ts` covers `extractText` and `extractQuoted` (the pure parsing surface).
The socket-bound parts of `whatsapp.ts` and all of `cli.ts` are excluded from coverage thresholds in
`vitest.config.ts` — they are thin adapters over hardware/TTY. Channel-independent behaviour is
tested through `test/handle.test.ts` with a fake message.

## Common tasks

| Task | Where |
| --- | --- |
| Support a new inbound media kind | `whatsapp.ts` `extractMedia` + `InboundMedia["kind"]` + `runner.ts` `buildUserMessage` |
| Change how a quoted message is rendered | `whatsapp.ts` `renderQuoted` (inbound) / `handle.ts` `formatForModel` (prompt) |
| Change outbound file typing | `whatsapp.ts` `sendFile` payload branch |
| Add a presence signal | `types.ts` (optional method) → `whatsapp.ts` → the caller that uses it |
| Add a transport | New file implementing `Channel`, wire in `src/index.ts` |

## Notes

- Typing indicators expire on WhatsApp after ~10s; `withTypingIndicator` in `handle.ts` re-asserts
  every 8s and always clears. Channels only expose the raw on/off.
- Reconnect uses exponential backoff capped at 30s and stops on `DisconnectReason.loggedOut`
  (the session must be re-linked manually). The reconnect timer checks `stopped` when it fires and
  is cleared in `stop()`, so a shutdown cannot resurrect the socket; `intakePaused` is instance
  state, so a reconnect *during* a drain stays paused.
- Messages that arrive while intake is paused are dropped by `handleOne` (the still-open socket
  has already received them at the transport level); WhatsApp does not redeliver them after a
  restart. See `docs/deployment.md` for the operational note.
- `markOnlineOnConnect: false` and `syncFullHistory: false` are deliberate: the agent should not
  mark the user's phone online or pull history it will never use.
