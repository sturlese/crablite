# crablite — single-stage image. Node + the gog CLI (for Gmail/Sheets). No build
# step: we run TypeScript directly with tsx.
FROM node:24-bookworm-slim

# System deps: TLS certs, curl (for gog install + skills), git, tini (init/reaper),
# poppler-utils (pdftotext — enables the bundled pdf skill).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git tini poppler-utils \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Bake the Google Workspace CLI (Gmail + Sheets skill). Override GOG_ASSET for arm64:
#   docker build --build-arg GOG_ASSET=gogcli_linux_arm64.tar.gz .
# Optionally pin integrity by passing GOG_SHA256 (recommended for production).
ARG GOG_ASSET=gogcli_linux_amd64.tar.gz
ARG GOG_SHA256=
RUN set -eu; \
    if curl -fsSL "https://github.com/steipete/gogcli/releases/latest/download/${GOG_ASSET}" -o /tmp/gog.tgz; then \
      if [ -n "${GOG_SHA256}" ]; then echo "${GOG_SHA256}  /tmp/gog.tgz" | sha256sum -c -; fi; \
      tar -xzO -f /tmp/gog.tgz gog > /usr/local/bin/gog && chmod 0755 /usr/local/bin/gog; \
      rm -f /tmp/gog.tgz; \
    else \
      echo "WARNING: gog not installed (${GOG_ASSET}); the Google skill will be hidden."; \
    fi

WORKDIR /app

# Install dependencies first (better layer caching). Fail on a lockfile mismatch
# rather than silently installing unpinned versions.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

# App source (skills, workspace templates, src).
COPY . .

# Run unprivileged. The state dir must be writable by the `node` user; a named
# volume mounted at /data inherits this ownership on first creation.
RUN mkdir -p /data && chown -R node:node /data
ENV CRABLITE_STATE_DIR=/data \
    NODE_ENV=production
USER node
VOLUME ["/data"]

# Entry runs the CLI; the compose command / `docker compose run` picks the subcommand.
ENTRYPOINT ["tini", "-s", "--", "node", "--import", "tsx", "src/index.ts"]
CMD ["whatsapp"]
