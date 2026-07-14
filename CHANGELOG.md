# Changelog

All notable changes to crablite are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-14

First release — a lightweight, faithful distillation of OpenClaw.

### Added

- Conversational agent on **WhatsApp** (Baileys, QR login) plus a **CLI** (`crablite chat`)
  sharing the same turn pipeline; sender allowlist closed by default.
- **Codex (ChatGPT) OAuth** as the only model auth: device-code flow with a PKCE
  browser-paste fallback and single-flight token refresh. No API keys.
- **File-based memory** (`SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, dated daily
  notes) with lexical `memory_search`/`memory_get`, startup context from recent notes,
  and a silent memory flush before old context is pruned.
- **Self-learning ("dreaming")**: notes that keep getting recalled are promoted into
  `MEMORY.md` nightly, with provenance markers, budget compaction and a `DREAMS.md` diary.
- **Folder skills** with progressive disclosure and binary gating; bundled **gog**
  (Gmail + Sheets), **weather**, **web-search** and **pdf** (`pdftotext`) skills.
- **Autonomous subagents** (`spawn_subagent`) with a recursion depth cap.
- **Proactivity**: one-shot reminders and recurring **routines** (daily / weekly /
  every-N-minutes, local time) the agent schedules, lists and cancels in conversation;
  a per-minute heartbeat delivers them and runs an optional daily check-in. Routines
  respect `NO_REPLY`; reminders always land.
- **Media & files**: inbound images (vision) and voice notes (transcribed through the
  Codex credential); inbound documents saved to the workspace `inbox/`; `send_file`
  delivers workspace files back to the chat — including from routines.
- **Rich chat behavior**: reply-quote context and group sender attribution reach the
  model; typing indicator (reactive and proactive turns), emoji reactions (`react`),
  read receipts and quoted replies in groups.
- **Security posture**: fail-closed allowlist, workspace-contained file tools,
  SSRF-guarded `web_fetch` with untrusted-data fencing, secrets at mode `0600`, and a
  hardened single-command Docker deployment (non-root, capabilities dropped).

[0.1.0]: https://github.com/sturlese/crablite/releases/tag/v0.1.0
