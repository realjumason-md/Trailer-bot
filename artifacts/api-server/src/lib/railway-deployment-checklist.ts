type DeploymentEnvironment = Record<string, string | undefined>;

function secretStatus(env: DeploymentEnvironment, name: string): string {
  return env[name]?.trim()
    ? "configured (value hidden)"
    : "MISSING — add directly in Railway";
}

export function buildRailwayDeploymentChecklist(
  env: DeploymentEnvironment,
): string {
  return [
    "Railway deployment checklist",
    "",
    "Required secrets (values are never sent in Telegram):",
    `TELEGRAM_BOT_TOKEN: ${secretStatus(env, "TELEGRAM_BOT_TOKEN")}`,
    `TELEGRAM_API_ID: ${secretStatus(env, "TELEGRAM_API_ID")}`,
    `TELEGRAM_API_HASH: ${secretStatus(env, "TELEGRAM_API_HASH")}`,
    "",
    "Optional:",
    `TELEGRAM_RESTART_NOTIFICATION_CHAT_ID: ${secretStatus(
      env,
      "TELEGRAM_RESTART_NOTIFICATION_CHAT_ID",
    )} — use /chatid in this private chat to get the value`,
    "",
    "Non-secret Railway settings:",
    "BOT_DATA_DIR=/data/telegram-video-bot (mount a volume at /data)",
    "TELEGRAM_LOCAL_API_PORT=18081 (default; normally leave unchanged)",
    "PORT is supplied automatically by Railway; do not hard-code it.",
    "NODE_ENV=production is set by the Docker image.",
    "",
    "For migration, stop the old service before starting the new one; only one service should poll this bot token at a time.",
    "Copy secret values manually from a secure source into Railway Variables.",
  ].join("\n");
}
