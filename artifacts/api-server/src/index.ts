import app from "./app";
import { logger } from "./lib/logger";
import {
  startTelegramVideoBot,
  stopTelegramVideoBot,
} from "./lib/telegram-video-bot";
import { setApplicationReady } from "./lib/readiness";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

let shuttingDown = false;

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  void startTelegramVideoBot()
    .then(() => {
      if (!shuttingDown) setApplicationReady(true);
    })
    .catch((error: unknown) => {
      if (shuttingDown) return;
      let safeMessage =
        error instanceof Error ? error.message : "unknown startup error";
      for (const secret of [
        process.env["TELEGRAM_BOT_TOKEN"],
        process.env["TELEGRAM_API_HASH"],
        process.env["TELEGRAM_API_ID"],
      ]) {
        if (secret) safeMessage = safeMessage.replaceAll(secret, "[redacted]");
      }
      logger.fatal(
        { error: safeMessage },
        "Telegram video bot failed to start",
      );
      server.close(() => process.exit(1));
    });
});

function shutdown(): void {
  shuttingDown = true;
  setApplicationReady(false);
  stopTelegramVideoBot();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
