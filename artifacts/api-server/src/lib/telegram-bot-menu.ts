export const TELEGRAM_BOT_MENU_BUTTONS = {
  help: "ℹ️ Help",
  status: "📊 Status",
  cancelWaiting: "🗑 Cancel waiting",
  stopActive: "⏹ Stop active",
  chatId: "🆔 Chat ID",
  runtimeSettings: "⚙️ Runtime settings",
  openInbox: "📥 Open inbox",
} as const;

const BUTTON_COMMANDS = new Map<string, string>([
  [TELEGRAM_BOT_MENU_BUTTONS.help, "/help"],
  [TELEGRAM_BOT_MENU_BUTTONS.status, "/status"],
  [TELEGRAM_BOT_MENU_BUTTONS.cancelWaiting, "/cancel waiting"],
  [TELEGRAM_BOT_MENU_BUTTONS.stopActive, "/cancel active"],
  [TELEGRAM_BOT_MENU_BUTTONS.chatId, "/chatid"],
  [TELEGRAM_BOT_MENU_BUTTONS.runtimeSettings, "/railwayvars"],
]);

export function telegramBotMenuCommand(
  text: string | undefined,
): string | null {
  return text ? (BUTTON_COMMANDS.get(text) ?? null) : null;
}

export function telegramBotMenuKeyboard(
  ownerTools: boolean,
): Record<string, unknown> {
  return {
    keyboard: [
      [
        { text: TELEGRAM_BOT_MENU_BUTTONS.help },
        { text: TELEGRAM_BOT_MENU_BUTTONS.status },
      ],
      [
        { text: TELEGRAM_BOT_MENU_BUTTONS.cancelWaiting },
        { text: TELEGRAM_BOT_MENU_BUTTONS.stopActive },
      ],
      [{ text: TELEGRAM_BOT_MENU_BUTTONS.chatId }],
      ...(ownerTools
        ? [
            [
              { text: TELEGRAM_BOT_MENU_BUTTONS.runtimeSettings },
              { text: TELEGRAM_BOT_MENU_BUTTONS.openInbox },
            ],
          ]
        : []),
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Send a video or paste a link",
  };
}
