# ---- Stage 1: Get pre-built telegram-bot-api binary ----
FROM aiogram/telegram-bot-api:latest AS telegram-api

# ---- Stage 2: Build the Node.js application ----
FROM node:24-bookworm-slim AS app-build

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm run typecheck \
  && pnpm --filter @workspace/api-server run build

# ---- Stage 3: Final runtime image ----
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV BOT_DATA_DIR=/data/telegram-video-bot

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    gosu \
    libssl3 \
    zlib1g \
  && rm -rf /var/lib/apt/lists/*

# Copy the already-compiled telegram-bot-api binary
COPY --from=telegram-api /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app
COPY --from=app-build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
