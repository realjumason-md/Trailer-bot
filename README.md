# Telegram Video Compressor

Source workspace for a Telegram bot that compresses uploaded videos to a chosen resolution and returns the result in the same chat.

## Requirements

- Node.js 24 or compatible
- pnpm
- Docker (for the Railway deployment; it installs FFmpeg, yt-dlp, Python, and Telegram's local Bot API server)

## Configure

Copy `.env.example` to `.env` and set the values in a secure local environment. Never commit `.env` or share bot tokens or API hashes.

Required environment variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`

To receive a message after each successful bot startup, open a private chat with the bot, send `/start` and `/chatid`, then set `TELEGRAM_RESTART_NOTIFICATION_CHAT_ID` to the returned ID in the local environment or Railway. The bot must have been started in that chat before Telegram allows it to send a message. A notification failure is logged and does not prevent the bot from starting.

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
3. Add these service variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `BOT_DATA_DIR=/data/telegram-video-bot`. To receive restart messages, also set `TELEGRAM_RESTART_NOTIFICATION_CHAT_ID` to your private chat ID from `/chatid`. Railway supplies `PORT`; do not hard-code it in Railway. `NODE_ENV=production` is set by the image.
4. Set the Railway healthcheck path to `/api/healthz` and keep the service to one replica. This bot uses long polling and keeps its current job in process memory.
5. If this bot is being moved from Telegram's hosted Bot API for the first time, call `logOut` once before starting this service. Do not call it on routine restarts or redeploys.

In the configured private chat, `/railwayvars` shows the bot's known non-secret runtime values and whether credentials are configured. It never prints credential values or dumps platform/operating-system environment variables. Set `TELEGRAM_RESTART_NOTIFICATION_CHAT_ID` to the ID returned by `/chatid`; the command is disabled until that ID is valid and only that private chat can use it. Set tokens and API hashes directly in Railway Variables. Only one service should poll a bot token at a time.

The service does not need a public domain to poll Telegram. If you add one, the only HTTP route exposed by this app is the health check.

The Docker image installs yt-dlp from PyPI and refreshes it when the container starts, so site-extractor fixes can arrive with a restart instead of waiting for Alpine's package repository. Update failures are logged but do not stop the bot; it keeps using the version included in the image. Set `YTDLP_AUTO_UPDATE=false` to disable startup updates and use the image's bundled version. This improves coverage for supported public sites, but cannot make every site work; private, login-gated, and DRM-protected sources remain unsupported.

## Bot behavior

- Accepts video uploads up to 4 GB.
- Accepts direct public HTTP/HTTPS download links to video files up to 4 GB.
- If a link opens a web page instead of a video file, tries yt-dlp extraction for public pages on supported sites, including TikTok. Site coverage and availability vary; private, login-gated, and DRM-protected videos are not supported. The bot does not use sign-ins or saved browser cookies.
- Probes the video's real dimensions before showing choices. The resolution menu shows the exact original dimensions, then 144p/240p/320p/360p/480p/640p/720p/960p/1080p/1440p/2160p presets that downscale the source, plus Custom resolution. Upscaling is rejected.
- Encodes with H.264 using the fast preset and a smaller-first CRF ladder (27, 31, 35, 38), stopping at the first output smaller than the source and below Telegram's 1.9 GB limit. Higher CRF values trade more image quality for smaller files; difficult inputs may need up to four full encoding attempts. Same-resolution mode copies the source audio; output is sent only if smaller than the original.
- Never sends the untouched original as a compressed result. Successful outputs are sent with Telegram's video method so they can play inline; if compression cannot make the file smaller, the bot explains the failure and keeps lower/custom-size choices available.
- Shows the original file size and progress during compression. The countdown appears only after at least 5% progress and 1 minute of encoding, so it is not extrapolated from the first tiny sample; it remains an estimate.
- Allows up to 12 hours for Telegram file retrieval/upload and supported-page extraction. FFmpeg encoding has no application-level timeout; hosting-platform limits are separate.
- Reports the compressed output size and returns an MP4 smaller than Telegram's 1.9 GB delivery limit, keeping the source filename when available (`compressed-video.mp4` otherwise).
- Sends each compressed video as a reply to the exact original upload or link message; includes the source URL in the caption when it fits.
- Accepts up to six outstanding videos per chat and compresses one video at a time. Other videos can wait in a bounded FIFO queue; the 30-minute selection timeout does not apply after a video is queued.
- `/status` shows active, queued, prepared, or downloading work. `/cancel` cancels the next waiting item; `/cancel active` stops the current compression.

## Source layout

- `artifacts/api-server/src/lib/telegram-video-bot.ts` — Telegram polling, upload handling, resolution selection, status, and cancellation.
- `artifacts/api-server/src/lib/video-processing.ts` — video probing, FFmpeg compression, and measured progress.
- `lib/` — workspace API, validation, and database packages.
