export function parseRestartNotificationChatId(
  value: string | undefined,
): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/u.test(normalized)) return null;

  const chatId = Number(normalized);
  return Number.isSafeInteger(chatId) && chatId > 0 ? chatId : null;
}
