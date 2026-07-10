---
name: gog
description: Google Workspace from the terminal — Gmail (search, read, summarize, draft, send) and Google Sheets (read, write, update, append), plus Calendar/Drive/Docs. Use this whenever the task involves the user's Google account.
metadata:
  crablite:
    requires:
      bins: ["gog"]
---

# gog — Gmail & Google Sheets

Drive Google Workspace by shelling out to the `gog` CLI with the `exec` tool. Requires a one-time
OAuth setup (see the end). Prefer `--json` output for anything you need to parse.

## ⚠️ Sending policy (read this first)
- **Never send an email without explicit user confirmation.** Default to creating a DRAFT, show the
  user exactly what you'll send (recipient, subject, body), and only send after they clearly say yes.
- The same applies to creating calendar events. Read/search freely; write/send only after a "yes".

## Gmail

- Search threads: `gog gmail search 'newer_than:7d from:boss@example.com' --max 10`
- Search individual messages (ignores threading): `gog gmail messages search "in:inbox is:unread" --max 20`
- Read a message: `gog gmail messages get <messageId>` (or open a thread: `gog gmail threads get <threadId>`)
- **Draft** (preferred): `gog gmail drafts create --to a@b.com --subject "Hi" --body-file - <<'EOF'` … `EOF`
- **Send a draft after confirmation**: `gog gmail drafts send <draftId>`
- Send directly (only after explicit confirmation): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "..." --reply-to-message-id <msgId>`
- Multi-line/HTML bodies: use `--body-file -` (stdin heredoc) for plain text, or `--body-html "<p>…</p>"`.

To **summarize a conversation**: `gog gmail threads get <threadId> --json`, read the messages, and write
a concise summary. Offer to draft a reply.

## Google Sheets

- Read a range: `gog sheets get <sheetId> "Tab!A1:D20" --json`
- Update a range: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Append rows: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Clear a range: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheet metadata (tab names/ids): `gog sheets metadata <sheetId> --json`

## Tips
- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, add `--json --no-input`.
- If a command fails with an auth error, the user needs to run the one-time setup below.

## One-time setup (the user does this once)
```
gog auth credentials /path/to/client_secret.json
gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets
gog auth list
```
`client_secret.json` is a Google Cloud OAuth **Desktop app** credential. Tokens are stored in gog's
encrypted keyring (persisted in the crablite state volume in Docker).
