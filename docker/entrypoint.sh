#!/bin/sh
set -eu

data_dir="${BOT_DATA_DIR:-/data/telegram-video-bot}"
mkdir -p "$data_dir"

if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
  if /opt/yt-dlp/bin/pip install --disable-pip-version-check --no-cache-dir --timeout 20 --retries 1 --upgrade yt-dlp; then
    echo "Using yt-dlp $(/usr/local/bin/yt-dlp --version)" >&2
  else
    echo "Warning: yt-dlp update failed; using bundled version $(/usr/local/bin/yt-dlp --version)" >&2
  fi
else
  echo "yt-dlp auto-update disabled; using bundled version $(/usr/local/bin/yt-dlp --version)" >&2
fi

chown -R node:node /data 2>/dev/null || true
chown -R node:node "$data_dir" 2>/dev/null || true
exec su-exec node:node "$@"
