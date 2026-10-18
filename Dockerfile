# ---- Stage 1: Pre-built telegram-bot-api (Alpine) ----
FROM aiogram/telegram-bot-api:latest AS telegram-api

# ---- Stage 2: Build the Node app ----
FROM node:24-alpine AS app-build

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm run typecheck \
  && pnpm --filter @workspace/api-server run build

# ---- Stage 3: Runtime (also Alpine so the binary works) ----
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV BOT_DATA_DIR=/data/telegram-video-bot

RUN apk add --no-cache \
    ca-certificates \
    ffmpeg \
    su-exec \
    libstdc++ \
    openssl \
    yt-dlp \
  && yt-dlp --version

# Copy the compatible binary
COPY --from=telegram-api /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app
COPY --from=app-build /app/artifacts/api-server/dist ./artifacts/api-server/dist

# Simple entrypoint that matches the original behaviour
COPY <<EOF /usr/local/bin/entrypoint.sh
#!/bin/sh
set -eu
data_dir="\${BOT_DATA_DIR:-/data/telegram-video-bot}"
mkdir -p "\$data_dir"
chown -R node:node /data 2>/dev/null || true
chown -R node:node "\$data_dir" 2>/dev/null || true
exec su-exec node:node "\$@"
EOF
RUN chmod 755 /usr/local/bin/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
