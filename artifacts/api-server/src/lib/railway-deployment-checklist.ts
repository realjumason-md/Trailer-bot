import { parseRestartNotificationChatId } from "./restart-notification.ts";

type DeploymentEnvironment = Record<string, string | undefined>;

function settingValue(
  env: DeploymentEnvironment,
  name: string,
  fallback: string,
): string {
  const value = env[name]?.trim() || fallback;
  const singleLine = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return (singleLine || "(empty)").slice(0, 160);
}

function secretStatus(env: DeploymentEnvironment, name: string): string {
  return env[name]?.trim()
    ? "configured (value hidden)"
    : "MISSING — add directly in Railway";
}

export function isAuthorizedRailwayVarsChat(
  chatType: string | undefined,
  chatId: number,
  configuredChatId: string | undefined,
): boolean {
  return (
    chatType === "private" &&
    parseRestartNotificationChatId(configuredChatId) === chatId
  );
}

export function buildRailwayDeploymentChecklist(
  env: DeploymentEnvironment,
): string {
  return [
    "Railway runtime configuration",
    "",
    "Runtime settings (actual values; known non-secret settings only):",
    `BOT_DATA_DIR: ${settingValue(
      env,
      "BOT_DATA_DIR",
      "(unset; app uses the OS temporary directory)",
    )}`,
    `TELEGRAM_LOCAL_API_PORT: ${settingValue(
      env,
      "TELEGRAM_LOCAL_API_PORT",
      "18081 (application default)",
    )}`,
    `PORT: ${settingValue(
      env,
      "PORT",
      "(not set; Railway normally supplies this)",
    )}`,
    `NODE_ENV: ${settingValue(env, "NODE_ENV", "(not set)")}`,
    `LOG_LEVEL: ${settingValue(env, "LOG_LEVEL", "info (application default)")}`,
    `TELEGRAM_RESTART_NOTIFICATION_CHAT_ID: ${settingValue(
      env,
      "TELEGRAM_RESTART_NOTIFICATION_CHAT_ID",
      "(not set)",
    )}`,
    "",
    "Credentials (values are never sent in Telegram):",
    `TELEGRAM_BOT_TOKEN: ${secretStatus(env, "TELEGRAM_BOT_TOKEN")}`,
    `TELEGRAM_API_ID: ${secretStatus(env, "TELEGRAM_API_ID")}`,
    `TELEGRAM_API_HASH: ${secretStatus(env, "TELEGRAM_API_HASH")}`,
    "",
    "Only the bot's known settings are listed; platform and operating-system variables are excluded.",
    "",
    "For migration, stop the old service before starting the new one; only one service should poll this bot token at a time.",
    "On Railway, mount a volume at /data and set BOT_DATA_DIR=/data/telegram-video-bot.",
  ].join("\n");
}
