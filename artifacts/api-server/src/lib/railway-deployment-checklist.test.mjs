import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRailwayDeploymentChecklist,
  isAuthorizedRailwayVarsChat,
} from "./railway-deployment-checklist.ts";

test("shows runtime values but never credential values", () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "BOT_TOKEN_MUST_NOT_LEAK",
    TELEGRAM_API_ID: "API_ID_MUST_NOT_LEAK",
    TELEGRAM_API_HASH: "API_HASH_MUST_NOT_LEAK",
    TELEGRAM_RESTART_NOTIFICATION_CHAT_ID: "123456789",
    BOT_DATA_DIR: "/data/telegram-video-bot",
    TELEGRAM_LOCAL_API_PORT: "18081",
    PORT: "8080",
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
  };

  const message = buildRailwayDeploymentChecklist(env);

  for (const name of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
  ]) {
    assert.match(message, new RegExp(name));
    assert.match(message, new RegExp(`${name}: configured \\(value hidden\\)`));
  }
  for (const value of [
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_API_ID,
    env.TELEGRAM_API_HASH,
  ]) {
    assert.equal(message.includes(value), false);
  }

  assert.match(message, /BOT_DATA_DIR: \/data\/telegram-video-bot/);
  assert.match(message, /TELEGRAM_LOCAL_API_PORT: 18081/);
  assert.match(message, /PORT: 8080/);
  assert.match(message, /NODE_ENV: production/);
  assert.match(message, /LOG_LEVEL: warn/);
  assert.match(message, /TELEGRAM_RESTART_NOTIFICATION_CHAT_ID: 123456789/);
});

test("shows defaults and missing runtime values clearly", () => {
  const message = buildRailwayDeploymentChecklist({});

  assert.match(message, /TELEGRAM_BOT_TOKEN: MISSING/);
  assert.match(message, /TELEGRAM_API_ID: MISSING/);
  assert.match(message, /TELEGRAM_API_HASH: MISSING/);
  assert.match(
    message,
    /BOT_DATA_DIR: \(unset; app uses the OS temporary directory\)/,
  );
  assert.match(
    message,
    /TELEGRAM_LOCAL_API_PORT: 18081 \(application default\)/,
  );
  assert.match(message, /PORT: \(not set; Railway normally supplies this\)/);
  assert.match(message, /NODE_ENV: \(not set\)/);
  assert.match(message, /LOG_LEVEL: info \(application default\)/);
  assert.match(message, /TELEGRAM_RESTART_NOTIFICATION_CHAT_ID: \(not set\)/);
  assert.match(message, /only one service should poll this bot token/);
});

test("allows only the configured private chat", () => {
  assert.equal(
    isAuthorizedRailwayVarsChat("private", 123456789, "123456789"),
    true,
  );
  assert.equal(
    isAuthorizedRailwayVarsChat("private", 987654321, "123456789"),
    false,
  );
  assert.equal(
    isAuthorizedRailwayVarsChat("group", 123456789, "123456789"),
    false,
  );
  assert.equal(
    isAuthorizedRailwayVarsChat("private", 123456789, undefined),
    false,
  );
  assert.equal(
    isAuthorizedRailwayVarsChat("private", 123456789, "invalid"),
    false,
  );
});
