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
ENV YTDLP_AUTO_UPDATE=true

RUN apk add --no-cache \
    ca-certificates \
    ffmpeg \
    su-exec \
    libstdc++ \
    openssl \
    python3 \
    py3-pip \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --disable-pip-version-check --no-cache-dir --timeout 20 --retries 1 "yt-dlp[default]" \
  && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
  && yt-dlp --version

# Copy the compatible binary
COPY --from=telegram-api /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app
COPY --from=app-build /app/artifacts/api-server/dist ./artifacts/api-server/dist

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
