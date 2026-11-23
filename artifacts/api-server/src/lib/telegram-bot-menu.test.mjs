import assert from "node:assert/strict";
import test from "node:test";
import {
  telegramBotMenuCommand,
  telegramBotMenuKeyboard,
  TELEGRAM_BOT_MENU_BUTTONS,
} from "./telegram-bot-menu.ts";

test("maps the reply-keyboard buttons to their existing command handlers", () => {
  assert.equal(telegramBotMenuCommand(TELEGRAM_BOT_MENU_BUTTONS.help), "/help");
  assert.equal(
    telegramBotMenuCommand(TELEGRAM_BOT_MENU_BUTTONS.status),
    "/status",
  );
  assert.equal(
    telegramBotMenuCommand(TELEGRAM_BOT_MENU_BUTTONS.cancelWaiting),
    "/cancel waiting",
  );
  assert.equal(
    telegramBotMenuCommand(TELEGRAM_BOT_MENU_BUTTONS.stopActive),
    "/cancel active",
  );
  assert.equal(
    telegramBotMenuCommand(TELEGRAM_BOT_MENU_BUTTONS.chatId),
    "/chatid",
  );
  assert.equal(
    telegramBotMenuCommand(TELEGRAM_BOT_MENU_BUTTONS.runtimeSettings),
    "/railwayvars",
  );
  assert.equal(
    telegramBotMenuCommand(TELEGRAM_BOT_MENU_BUTTONS.openInbox),
    null,
  );
  assert.equal(telegramBotMenuCommand("640p"), null);
});

test("shows the same command buttons to every user", () => {
  const menu = telegramBotMenuKeyboard();
  const buttonTexts = menu.keyboard.flat().map((button) => button.text);

  assert.equal(menu.is_persistent, true);
  assert.equal(menu.resize_keyboard, true);
  assert.deepEqual(buttonTexts, Object.values(TELEGRAM_BOT_MENU_BUTTONS));
});
