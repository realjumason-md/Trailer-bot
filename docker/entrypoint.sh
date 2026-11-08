#!/bin/sh
set -eu

data_dir="${BOT_DATA_DIR:-/tmp/telegram-video-bot}"
mkdir -p "$data_dir"

# Write Netscape cookies from env (optional)
if [ -n "${YTDLP_COOKIES_CONTENT:-}" ]; then
  cookies_path="${YTDLP_COOKIES_FILE:-$data_dir/cookies.txt}"
  mkdir -p "$(dirname "$cookies_path")"
  # Use printf so newlines in the variable are preserved
  printf '%s\n' "$YTDLP_COOKIES_CONTENT" > "$cookies_path"
  chmod 600 "$cookies_path"
  export YTDLP_COOKIES_FILE="$cookies_path"
  echo "Wrote yt-dlp cookies to $cookies_path" >&2
fi

if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
  if /opt/yt-dlp/bin/pip install --disable-pip-version-check --no-cache-dir --timeout 20 --retries 1 --upgrade yt-dlp; then
    echo "Using yt-dlp $(/usr/local/bin/yt-dlp --version)" >&2
  else
    echo "Warning: yt-dlp update failed; using bundled version $(/usr/local/bin/yt-dlp --version)" >&2
  fi
else
  echo "yt-dlp auto-update disabled; using bundled version $(/usr/local/bin/yt-dlp --version)" >&2
fi

# On free tier there is often no /data volume — stay on /tmp
chown -R node:node "$data_dir" 2>/dev/null || true
exec su-exec node:node "$@"
