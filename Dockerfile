FROM node:24-bookworm-slim AS telegram-api-build

ARG TELEGRAM_BOT_API_COMMIT=e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    g++ \
    git \
    gperf \
    libssl-dev \
    make \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

RUN git init /src/telegram-bot-api \
  && git -C /src/telegram-bot-api remote add origin https://github.com/tdlib/telegram-bot-api.git \
  && git -C /src/telegram-bot-api fetch --depth=1 origin "${TELEGRAM_BOT_API_COMMIT}" \
  && git -C /src/telegram-bot-api checkout --detach FETCH_HEAD \
  && git -C /src/telegram-bot-api submodule update --init --recursive --depth 1

RUN cmake -S /src/telegram-bot-api -B /src/telegram-bot-api/build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG" \
    -DCMAKE_INSTALL_PREFIX=/usr/local \
  && cmake --build /src/telegram-bot-api/build --target install --parallel 2

FROM node:24-bookworm-slim AS app-build

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm run typecheck \
  && pnpm --filter @workspace/api-server run build

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

COPY --from=telegram-api-build /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api
COPY --from=telegram-api-build /usr/local/lib/ /usr/local/lib/
RUN ldconfig

WORKDIR /app
COPY --from=app-build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
