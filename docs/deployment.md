# crablite — Deployment guide

crablite is designed to run as **one container with one persistent volume**. Everything —
configuration, memory, Codex tokens, WhatsApp session, Google keyring — lives in the state directory
(`/data` in Docker, `~/.crablite` locally).

## Prerequisites

- Docker + Docker Compose v2 (`docker compose version`), **or** Node ≥ 20 + pnpm for a local run.
- A **ChatGPT / Codex account** (the only model auth crablite implements).
- Optional, for Gmail/Sheets: a Google Cloud **OAuth "Desktop app"** credential (`client_secret.json`).

## 1. Configure

```bash
cp .env.example .env
```

Edits in `.env` (the allowlist is **required** — the agent ignores everyone until it's set):

```ini
CRABLITE_ALLOW_FROM=34600111222        # REQUIRED: your WhatsApp number(s). Closed by default.
CRABLITE_AGENT_NAME=Crab
GOG_KEYRING_PASSWORD=some-long-secret  # persists Google tokens across restarts
# On Apple Silicon hosts:
# GOG_ASSET=gogcli_linux_arm64.tar.gz
```

## 2. Build

```bash
docker compose build
# Apple Silicon (arm64):
docker compose build --build-arg GOG_ASSET=gogcli_linux_arm64.tar.gz
```

The image is a single `node:24-bookworm-slim` stage with `ca-certificates curl git tini`, the `gog`
binary baked in, and the app run via `tsx` (no build step). If the `gog` download fails for your
arch, the build still succeeds and the Google skill is simply hidden (`crablite doctor` will show it).

## 3. Sign in to Codex

```bash
docker compose run --rm crablite login
```

- **Device code:** open the printed URL, enter the code. Done.
- **Fallback (browser):** open the printed URL, sign in, and paste the redirected
  `http://localhost:1455/...` URL (or just the `code`) back into the terminal.

Tokens are written to the volume at `/data/auth/codex.json` and auto‑refreshed thereafter.

## 4. Start (WhatsApp)

```bash
docker compose up            # or: docker compose up -d && docker compose logs -f
```

A QR code prints in the logs. In your phone: **WhatsApp → Settings → Linked Devices → Link a device**
and scan it. The session persists in `/data/auth/whatsapp/`, so you only do this once (until you
unlink or the session expires). Message your own number to talk to the crab.

## 5. Google (optional)

```bash
# copy your Google OAuth desktop credential into the volume, then:
docker compose exec crablite gog auth credentials /data/client_secret.json
docker compose exec crablite gog auth add you@gmail.com --services gmail,sheets,calendar,drive,docs
docker compose exec crablite gog auth list
```

Set `GOG_ACCOUNT=you@gmail.com` and `GOG_KEYRING_PASSWORD=...` in `.env` so the agent doesn't need
`--account` and tokens survive restarts. The agent will **draft** emails and wait for your explicit
confirmation before sending.

## Operating

| Action | Command |
|---|---|
| Status (auth, gog, skills, config) | `docker compose exec crablite node --import tsx src/index.ts doctor` |
| Talk in a terminal (debug) | `docker compose run --rm crablite chat` |
| Run self‑learning now | `docker compose exec crablite node --import tsx src/index.ts dream` |
| Follow logs | `docker compose logs -f` |
| Stop | `docker compose down` (the `crablite-data` volume persists) |

Stopping is graceful: on SIGTERM crablite pauses intake and drains in‑flight turns for up to 25s
before exiting (`stop_grace_period: 30s` in `docker-compose.yml` stays above that internal cap).
Note that messages **arriving during** the drain window are acked at the transport level by the
still‑open socket but not processed, and WhatsApp does not redeliver them after restart — senders
should assume a message sent while the bot is shutting down is dropped.

Nightly dreaming runs automatically inside the `whatsapp` process (default ~03:00 local; set the
container `TZ` env or `dreamHour` in config).

## Back up / migrate

Everything is in the named volume `crablite-data`. Back it up with:

```bash
docker run --rm -v crablite-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/crablite-backup.tgz -C /data .
```

Restore by extracting into a fresh `crablite-data` volume. Because memory is plain Markdown, you can
also just copy `workspace/` somewhere and read/edit it directly.

## Local (no Docker)

```bash
pnpm install
pnpm crablite login
pnpm crablite whatsapp     # or: pnpm crablite chat
```

State goes to `~/.crablite`. Install [`gog`](https://gogcli.sh) if you want Gmail/Sheets locally.

## Troubleshooting

- **Model calls fail (HTTP 4xx).** The Codex `/responses` contract is private and may change. Adjust
  headers/model/base URL in `src/codex/responses.ts`, or set `CRABLITE_CODEX_BASE_URL` /
  `CRABLITE_MODEL`. See the note in the README.
- **QR never appears / connection closes.** Check `docker compose logs`; ensure the container has
  network. Delete `/data/auth/whatsapp` to force a fresh link.
- **`gog` commands fail.** Re‑run the `gog auth add` step; confirm `GOG_KEYRING_PASSWORD` is set so
  the keyring can be unlocked non‑interactively.
- **Wrong architecture for gog.** Rebuild with the matching `GOG_ASSET`.
