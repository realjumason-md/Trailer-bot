# Contributing

## Requirements

- Node.js 24
- pnpm 10.26.1

Unit tests and typechecking do not need Telegram credentials, Docker, FFmpeg,
yt-dlp, or the Telegram Bot API binary. Those system tools are required only
when running the bot end to end.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server run test
```

GitHub Actions runs the same checks and builds the production Docker image on
pushes to `main` and pull requests targeting `main`.

## Architecture

- `artifacts/api-server/src/lib/telegram-video-bot.ts` polls Telegram, accepts
  uploads and links, manages resolution selection, and runs the single-worker
  in-memory queue.
- `artifacts/api-server/src/lib/remote-video-download.ts` validates public
  HTTP(S) targets, pins DNS results, revalidates redirects, and bounds direct
  downloads by size.
- `artifacts/api-server/src/lib/tiktok-link-handler.ts` runs yt-dlp through the
  local public-egress proxy for supported site pages.
- `artifacts/api-server/src/lib/video-processing.ts` probes and compresses
  videos with ffprobe and FFmpeg.
- `lib/api-zod` contains the generated health-response schema used by the API
  server. `lib/api-spec` is its OpenAPI source and Zod code generator.

The deployment is designed for one long-polling replica. Jobs, rate-limit
windows, and queue state live in process memory, so restarts cancel in-flight
work and reset rate-limit windows rather than resuming it.
