# Telegram Video Compressor

Source workspace for a Telegram bot that compresses uploaded videos to a chosen resolution and returns the result in the same chat.

## Requirements

- Node.js 24
- pnpm 10.26.1
- Docker for the Railway image build
- For a local bot run: FFmpeg/ffprobe, yt-dlp, and Telegram's local
  `telegram-bot-api` binary available on `PATH`

## Configure

Copy `.env.example` to `.env` and set the values in a secure local environment. Never commit `.env` or share bot tokens or API hashes.

Required environment variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`

To receive a message after each successful bot startup, open a private chat with the bot, send `/start` and `/chatid`, then set `TELEGRAM_RESTART_NOTIFICATION_CHAT_ID` to the returned ID in the local environment or Railway. The bot must have been started in that chat before Telegram allows it to send a message. A notification failure is logged and does not prevent the bot from starting.

Before first moving a bot from Telegram's hosted Bot API to a local Bot API server, call Telegram's `logOut` method securely. This releases the hosted API session so the local server can receive updates. Do this for the migration, not on each restart. See the [Telegram Bot API documentation](https://core.telegram.org/bots/api#logout).

## Run locally

The default local run mode does not need Telegram credentials or media
binaries. It starts the health-check server without polling Telegram, so you
can work on the API and run the test suite without building Telegram's C++
Bot API server.

```sh
cp .env.example .env
pnpm install
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/api-server run dev
```

The local `.env` file is loaded by the server start script. Leave
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID`, and `TELEGRAM_API_HASH` blank for
server-only development; set all three to enable polling. `PORT=8080` is set in
`.env.example`. The API health check is available at `/api/healthz`; in bot
mode it becomes healthy only after the local Bot API server and bot start.

To run the bot without Docker on Debian or Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-venv
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip yt-dlp
```

Install Telegram's official
[`telegram-bot-api`](https://github.com/tdlib/telegram-bot-api) binary and make
sure it is on `PATH`; the Node process starts it automatically. Set the three
Telegram variables in `.env` and run
`pnpm --filter @workspace/api-server run dev`. The local Bot API requires an
API ID and hash from [my.telegram.org](https://my.telegram.org). Before the
first migration from Telegram's hosted Bot API, call `logOut` once as described
above.

## Deploy to Railway

Railway builds the root `Dockerfile`. It compiles Telegram's official local Bot API server and installs FFmpeg, `ffprobe`, and yt-dlp, so the service does not depend on packages preinstalled in the Railway image. Without a volume, the bot stores working files under `/tmp/telegram-video-bot`; set `BOT_DATA_DIR` to `/data/telegram-video-bot` when using the persistent volume below.

1. Create a Railway service from this repository and keep its root directory at the repository root.
2. Add a Railway volume mounted at `/data`. Set `BOT_DATA_DIR` to `/data/telegram-video-bot`. The volume stores Telegram's local API state and temporary video files; size it for the input video and the compressed output at the same time.
3. Add these service variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `BOT_DATA_DIR=/data/telegram-video-bot`. To receive restart messages, also set `TELEGRAM_RESTART_NOTIFICATION_CHAT_ID` to your private chat ID from `/chatid`. Railway supplies `PORT`; do not hard-code it in Railway. `NODE_ENV=production` is set by the image.
4. Set the Railway healthcheck path to `/api/healthz` and keep the service to one replica. This bot uses long polling and keeps queue state in process memory; a restart cancels in-flight jobs instead of resuming them.
5. If this bot is being moved from Telegram's hosted Bot API for the first time, call `logOut` once before starting this service. Do not call it on routine restarts or redeploys.

In the configured private chat, `/railwayvars` shows the bot's known non-secret runtime values and whether credentials are configured. It never prints credential values or dumps platform/operating-system environment variables. Set `TELEGRAM_RESTART_NOTIFICATION_CHAT_ID` to the ID returned by `/chatid`; the command is disabled until that ID is valid and only that private chat can use it. Set tokens and API hashes directly in Railway Variables. Only one service should poll a bot token at a time.

The service does not need a public domain to poll Telegram. If you add one, the only HTTP route exposed by this app is the health check.

The Docker image installs yt-dlp from PyPI and refreshes it when the container starts, so site-extractor fixes can arrive with a restart instead of waiting for Alpine's package repository. Update failures are logged but do not stop the bot; it keeps using the version included in the image. Set `YTDLP_AUTO_UPDATE=false` to disable startup updates and use the image's bundled version. This improves coverage for supported sites, but cannot make every site work; DRM-protected sources remain unsupported.

For supported sites that require an authenticated session, export a Netscape-format cookie file from a browser session that is authorized to view the video. Transfer it through a secure deployment workflow: set `YTDLP_COOKIES_FILE` to a readable file path, or store the file contents in the deployment's secret-variable manager as `YTDLP_COOKIES_CONTENT`. The entrypoint writes the latter with restricted permissions. Replace the file when the session expires. Never commit cookie files or paste their contents into chat. Cookies only grant the access of the account they came from; they do not unlock private content the account cannot view or DRM-protected media.

## Bot behavior

- Accepts video uploads up to 4 GB.
- Accepts direct public HTTP/HTTPS download links to video files up to 4 GB.
- Uses yt-dlp for public HLS/DASH manifests and supported video pages, including common extractors for YouTube, TikTok, Instagram, Facebook, X, Reddit, and Vimeo. Coverage changes with site behavior and yt-dlp versions; this is not support for every website.
- Prefers MP4 video/audio formats when available and merges separate streams. Progress includes yt-dlp download progress plus output-size monitoring. Login-required, geo-restricted, rate-limited, unsupported, inaccessible, and DRM-protected sources have distinct user-facing outcomes.
- A configured Netscape cookies file can be used only for content the associated account is allowed to view. Private or login-only content may still be inaccessible, and DRM-protected media remains unsupported.
- Probes the video's real dimensions before showing choices. The resolution menu shows the exact original dimensions, then 144p/240p/320p/360p/480p/640p/720p/960p/1080p/1440p/2160p presets that downscale the source, plus Custom resolution. Upscaling is rejected.
- Encodes with H.264 using the fast preset and a smaller-first CRF ladder (27, 31, 35, 38), stopping at the first output smaller than the source and below Telegram's 1.9 GB limit. Higher CRF values trade more image quality for smaller files; difficult inputs may need up to four full encoding attempts. Same-resolution mode copies the source audio; output is sent only if smaller than the original.
- Never sends the untouched original as a compressed result. Successful outputs are sent with Telegram's video method so they can play inline; if compression cannot make the file smaller, the bot explains the failure and keeps lower/custom-size choices available.
- Shows the original file size and progress during compression. The countdown appears only after at least 5% progress and 1 minute of encoding, so it is not extrapolated from the first tiny sample; it remains an estimate.
- Allows up to 12 hours for Telegram file retrieval/upload and supported-page extraction. ffprobe has a five-minute timeout, and each compression—including its retries and final probe—has a 12-hour total application-level deadline. Hosting-platform CPU and memory limits are separate.
- Reports the compressed output size and returns an MP4 smaller than Telegram's 1.9 GB delivery limit, keeping the source filename when available (`compressed-video.mp4` otherwise).
- Sends each compressed video as a reply to the exact original upload or link message; includes the source URL in the caption when it fits.
- Accepts up to six outstanding videos across the bot, compresses one video at a time, and limits each Telegram user to six submissions per rolling hour and 20 per rolling 24 hours. Other videos wait in a bounded FIFO queue; the 30-minute selection timeout does not apply after a video is queued.
- `/status` shows active, queued, prepared, or downloading work. `/cancel` cancels the next waiting item; `/cancel active` stops the current compression.
- Queue and rate-limit state are in memory. Restarts cancel pending and active jobs and reset the hourly/daily quotas. A startup and 30-minute cleanup sweep removes untracked job artifacts older than two hours while preserving files referenced by the current queue. Telegram's own `api-temp` directory is left to the local Bot API server.

## Source layout

- `artifacts/api-server/src/lib/telegram-video-bot.ts` — Telegram polling, upload handling, resolution selection, status, and cancellation.
- `artifacts/api-server/src/lib/video-processing.ts` — video probing, FFmpeg compression, and measured progress.
- `lib/api-zod` — the health-response schema used by the server.
- `lib/api-spec` — the OpenAPI source and generator for `lib/api-zod`.
