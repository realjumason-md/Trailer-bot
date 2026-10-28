import assert from "node:assert/strict";
import test from "node:test";
import { parseRestartNotificationChatId } from "./restart-notification.ts";

test("accepts a configured positive Telegram private chat ID", () => {
  assert.equal(parseRestartNotificationChatId("123456789"), 123456789);
  assert.equal(parseRestartNotificationChatId(" 123456789 "), 123456789);
});

test("disables notifications for blank or invalid chat IDs", () => {
  for (const value of [
    undefined,
    "",
    " ",
    "0",
    "-123456789",
    "123.45",
    "not-a-chat-id",
    "9007199254740992",
  ]) {
    assert.equal(parseRestartNotificationChatId(value), null);
  }
});
