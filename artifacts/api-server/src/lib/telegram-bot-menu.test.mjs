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

test("shows owner tools only in the configured owner's menu", () => {
  const userMenu = telegramBotMenuKeyboard(false);
  const ownerMenu = telegramBotMenuKeyboard(true);
  const buttonTexts = (menu) =>
    menu.keyboard.flat().map((button) => button.text);

  assert.equal(userMenu.is_persistent, true);
  assert.equal(userMenu.resize_keyboard, true);
  assert.ok(buttonTexts(userMenu).includes(TELEGRAM_BOT_MENU_BUTTONS.help));
  assert.ok(buttonTexts(userMenu).includes(TELEGRAM_BOT_MENU_BUTTONS.status));
  assert.ok(
    !buttonTexts(userMenu).includes(TELEGRAM_BOT_MENU_BUTTONS.openInbox),
  );
  assert.ok(
    buttonTexts(ownerMenu).includes(TELEGRAM_BOT_MENU_BUTTONS.runtimeSettings),
  );
  assert.ok(
    buttonTexts(ownerMenu).includes(TELEGRAM_BOT_MENU_BUTTONS.openInbox),
  );
});
