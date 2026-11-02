import assert from "node:assert/strict";
import test from "node:test";
import { buildRailwayDeploymentChecklist } from "./railway-deployment-checklist.ts";

test("shows required variable names and status without exposing secret values", () => {
  const secrets = {
    TELEGRAM_BOT_TOKEN: "BOT_TOKEN_MUST_NOT_LEAK",
    TELEGRAM_API_ID: "API_ID_MUST_NOT_LEAK",
    TELEGRAM_API_HASH: "API_HASH_MUST_NOT_LEAK",
    TELEGRAM_RESTART_NOTIFICATION_CHAT_ID: "CHAT_ID_MUST_NOT_LEAK",
  };

  const message = buildRailwayDeploymentChecklist(secrets);

  for (const name of Object.keys(secrets)) {
    assert.match(message, new RegExp(name));
  }
  for (const value of Object.values(secrets)) {
    assert.equal(message.includes(value), false);
  }
  assert.match(message, /configured \(value hidden\)/);
});

test("marks absent secrets and includes safe Railway defaults", () => {
  const message = buildRailwayDeploymentChecklist({});

  assert.match(message, /TELEGRAM_BOT_TOKEN: MISSING/);
  assert.match(message, /TELEGRAM_API_ID: MISSING/);
  assert.match(message, /TELEGRAM_API_HASH: MISSING/);
  assert.match(message, /BOT_DATA_DIR=\/data\/telegram-video-bot/);
  assert.match(message, /TELEGRAM_LOCAL_API_PORT=18081/);
  assert.match(message, /PORT is supplied automatically by Railway/);
  assert.match(message, /NODE_ENV=production is set by the Docker image/);
  assert.match(message, /only one service should poll this bot token/);
});
