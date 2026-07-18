# src/media — voice notes and chat files

## Purpose

Turn inbound media into something the model can use, and move files between the chat and the
workspace. Voice notes are transcribed through the existing Codex credential (no extra key);
documents land on plain disk so the normal tools (`read`, `exec`, skills, `send_file`) can act on
them.

## Key entry points

| File | Role |
| --- | --- |
| `stt.ts` | `transcribeAudio(data, mimetype)` → transcript string or `null`. POSTs to `<CODEX_BASE_URL>/audio/transcriptions` with model `gpt-4o-transcribe`. |
| `files.ts` | `MAX_FILE_BYTES` (20 MB, both directions), `guessMimetype(file)`, `formatSize(bytes)`, `sanitizeName(name)`, `saveInboundDocument(media)` → workspace-relative path. |

## Use these

- **`MAX_FILE_BYTES`** as the one transfer cap. `tools.ts` (`send_file`) and `channels/whatsapp.ts`
  (media download) both import it — do not introduce a second limit.
- **`guessMimetype`** for outbound files; **`sanitizeName`** for anything derived from a
  user/remote-supplied filename.
- **`saveInboundDocument`** to persist an attachment; it returns the posix, workspace-relative path
  the agent's tools accept (`inbox/…`).
- **`CODEX_BASE_URL` + `getAccessToken()`** as the template for any further Codex-backed media
  endpoint (`stt.ts` is the reference implementation).

## Avoid / anti-patterns

- Do **not** ask for a separate transcription API key. Reusing the Codex credential is the design
  (faithful to OpenClaw's `transcribeOpenAiCodexAudio`).
- Do **not** let STT failures break a turn. `transcribeAudio` returns `null` on any error and
  `runner.ts` substitutes a placeholder — a failed transcription must not lose the message.
- Do **not** trust a remote filename. `sanitizeName` flattens separators/controls and strips
  leading dots (no dotfiles, no traversal remnants); `saveInboundDocument` also date-prefixes and
  collision-suffixes.
- Do **not** persist image bytes into the transcript. `runner.ts` sends bytes in the live turn and
  stores a `[image]` placeholder; keep that split for any new binary media.
- Do **not** implement document extraction in TypeScript. Extraction is a **skill** with a gated
  binary (the bundled `pdf` skill needs `pdftotext`) — that is the deliberate simplification over
  OpenClaw's pdfjs plugin.
- Do **not** save documents outside `inbox/`. Anything outside the workspace is unreachable by the
  tools on purpose.

## Data & contracts

- Input: `InboundMedia` from `channels/types.ts` (`kind`, `data: Buffer`, `mimetype`, `filename?`).
- Output of `saveInboundDocument`: `inbox/<YYYY-MM-DD>-<sanitized-name>[-N].<ext>`, relative to the
  workspace, posix separators.
- `MIME_BY_EXT` in `files.ts` is the extension → mimetype table; unknown ⇒
  `application/octet-stream`.
- Images over 10 MB are rejected with a placeholder in `runner.ts` (below the 20 MB transfer cap,
  because they are base64-inlined into the request).

## Tests

`test/files.test.ts` (mimetype/size formatting, `sanitizeName` edge cases, `saveInboundDocument`
dating + collision suffixing) and `test/stt.test.ts` (auth header wiring, non-OK and error paths
returning `null`). Network mocked.

## Common tasks

| Task | Where |
| --- | --- |
| Support a new file extension | `MIME_BY_EXT` in `files.ts` |
| Change the transfer cap | `MAX_FILE_BYTES` (single source) |
| Change the STT model | `STT_MODEL` in `stt.ts` |
| Handle a new inbound media kind | `channels/whatsapp.ts` `extractMedia` → `runner.ts` `buildUserMessage` → here if it needs storage |
| Read a new document format | Add a **skill** with a `requires.bins` gate, not code here |

## Notes

- `stt.ts` maps mimetype → file extension for the multipart filename; some endpoints reject a
  generic name, hence the `ext()` helper.
- `inbox/` is created lazily on first document; it is not part of `ensureStateDirs()`.
