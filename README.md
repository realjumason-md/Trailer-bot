# Telegram Video Compressor

Source workspace for a Telegram bot that compresses uploaded videos to a chosen resolution and returns the result in the same chat.

## Requirements

- Node.js 24 or compatible
- pnpm
- Docker (for the Railway deployment; it installs FFmpeg, yt-dlp, and Telegram's local Bot API server)

## Configure

Copy `.env.example` to `.env` and set the values in a secure local environment. Never commit `.env` or share bot tokens or API hashes.

Required environment variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`

Before first moving a bot from Telegram's hosted Bot API to a local Bot API server, call Telegram's `logOut` method securely. This releases the hosted API session so the local server can receive updates. Do this for the migration, not on each restart. See the [Telegram Bot API documentation](https://core.telegram.org/bots/api#logout).

## Run

```sh
pnpm install
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/api-server run dev
```

The API health check is available at `/api/healthz`. It returns a successful response only after the local Bot API server and bot have started.

## Deploy to Railway

Railway builds the root `Dockerfile`. It compiles Telegram's official local Bot API server and installs FFmpeg, `ffprobe`, and yt-dlp, so the service does not depend on packages preinstalled in the Railway image.

1. Create a Railway service from this repository and keep its root directory at the repository root.
2. Add a Railway volume mounted at `/data`. Set `BOT_DATA_DIR` to `/data/telegram-video-bot`. The volume stores Telegram's local API state and temporary video files; size it for the input video and the compressed output at the same time.
3. Add these service variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `BOT_DATA_DIR=/data/telegram-video-bot`. Railway supplies `PORT`; do not hard-code it in Railway. `NODE_ENV=production` is set by the image.
4. Set the Railway healthcheck path to `/api/healthz` and keep the service to one replica. This bot uses long polling and keeps its current job in process memory.
5. If this bot is being moved from Telegram's hosted Bot API for the first time, call `logOut` once before starting this service. Do not call it on routine restarts or redeploys.

The service does not need a public domain to poll Telegram. If you add one, the only HTTP route exposed by this app is the health check.

## Bot behavior

- Accepts video uploads up to 4 GB.
- Accepts direct public HTTP/HTTPS download links to video files up to 4 GB. Web pages and streaming-platform or playlist links are not downloaded.
- Accepts public TikTok post and share links through yt-dlp. No API key, login, or browser cookies are used; private, login-gated, or otherwise unavailable posts are rejected with a chat message. Public availability may vary by region or TikTok changes.
- After the upload is prepared, asks the user to choose a preset or custom resolution.
- Shows the original file size during compression, with progress and a countdown based on the encoder's measured speed.
- Reports the compressed output size and returns an MP4 smaller than Telegram's 1.9 GB delivery limit, keeping the source filename when available (`compressed-video.mp4` otherwise).
- Prepares up to two uploads or links at a time and compresses one video at a time. Other videos can wait in a bounded FIFO queue (five queued jobs maximum).
- `/status` shows active, queued, prepared, or downloading work. `/cancel` cancels the next waiting item; `/cancel active` stops the current compression.

## Source layout

- `artifacts/api-server/src/lib/telegram-video-bot.ts` — Telegram polling, upload handling, resolution selection, status, and cancellation.
- `artifacts/api-server/src/lib/video-processing.ts` — video probing, FFmpeg compression, and measured progress.
- `lib/` — workspace API, validation, and database packages.
