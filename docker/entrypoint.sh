#!/bin/sh
set -eu

data_dir="${BOT_DATA_DIR:-/data/telegram-video-bot}"
mkdir -p "$data_dir"

if [ -d /data ]; then
  chown node:node /data
fi
chown node:node "$data_dir"

exec gosu node:node "$@"
