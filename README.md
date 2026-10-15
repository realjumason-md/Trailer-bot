# Telegram Video Compressor

Source workspace for a Telegram bot that compresses uploaded videos to a chosen resolution and returns the result in the same chat.

## Requirements

- Node.js 24 or compatible
- pnpm
- `ffmpeg` and `ffprobe`
- Telegram's local Bot API server (`telegram-bot-api`) for large-file handling
- A PostgreSQL database for the API workspace

## Configure

Copy `.env.example` to `.env` and set the values in a secure local environment. Never commit `.env` or share bot tokens, API hashes, or session secrets.

Required environment variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `DATABASE_URL`
- `SESSION_SECRET`

Before first moving a bot from Telegram's hosted Bot API to a local Bot API server, call Telegram's `logOut` method securely. This releases the hosted API session so the local server can receive updates. Do this for the migration, not on each restart. See the [Telegram Bot API documentation](https://core.telegram.org/bots/api#logout).

## Run

```sh
pnpm install
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run dev
```

The API health check is available at `/api/healthz`.

## Bot behavior

- Accepts video uploads up to 4 GB.
- After the upload is prepared, asks the user to choose a preset or custom resolution.
- Shows compression progress and an ETA based on the encoder's measured speed; the estimate updates during compression.
- Returns an MP4 smaller than Telegram's 1.9 GB delivery limit.
- Processes one compression job at a time.

## Source layout

- `artifacts/api-server/src/lib/telegram-video-bot.ts` — Telegram polling, upload handling, resolution selection, status, and cancellation.
- `artifacts/api-server/src/lib/video-processing.ts` — video probing, FFmpeg compression, and measured progress.
- `lib/` — workspace API, validation, and database packages.
