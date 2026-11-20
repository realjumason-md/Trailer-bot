import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_TELEGRAM_INBOX_MESSAGES = 1_000;
const MAX_INBOX_TEXT_LENGTH = 4_096;

export type TelegramInboxMessage = {
  updateId: number;
  userId: number;
  chatId: number;
  firstName: string;
  username?: string;
  contentType: string;
  text: string;
  fileName?: string;
  fileSize?: number;
  receivedAt: number;
};

export type TelegramInboxUser = {
  userId: number;
  chatId: number;
  firstName: string;
  username?: string;
  messageCount: number;
  lastMessageAt: number;
};

function isInboxMessage(value: unknown): value is TelegramInboxMessage {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<TelegramInboxMessage>;
  return (
    Number.isSafeInteger(entry.updateId) &&
    Number.isSafeInteger(entry.userId) &&
    Number.isSafeInteger(entry.chatId) &&
    typeof entry.firstName === "string" &&
    (entry.username === undefined || typeof entry.username === "string") &&
    typeof entry.contentType === "string" &&
    typeof entry.text === "string" &&
    (entry.fileName === undefined || typeof entry.fileName === "string") &&
    (entry.fileSize === undefined || Number.isFinite(entry.fileSize)) &&
    typeof entry.receivedAt === "number" &&
    Number.isSafeInteger(entry.receivedAt) &&
    entry.receivedAt >= 0
  );
}

function normalizeMessage(entry: TelegramInboxMessage): TelegramInboxMessage {
  return {
    updateId: entry.updateId,
    userId: entry.userId,
    chatId: entry.chatId,
    firstName: entry.firstName.slice(0, 80),
    ...(entry.username ? { username: entry.username.slice(0, 64) } : {}),
    contentType: entry.contentType.slice(0, 32),
    text: entry.text.slice(0, MAX_INBOX_TEXT_LENGTH),
    ...(entry.fileName ? { fileName: entry.fileName.slice(0, 120) } : {}),
    ...(entry.fileSize != null && Number.isFinite(entry.fileSize)
      ? { fileSize: Math.max(0, entry.fileSize) }
      : {}),
    receivedAt: entry.receivedAt,
  };
}

export class TelegramInboxStore {
  readonly #filePath: string;
  readonly #maxMessages: number;
  #messages: TelegramInboxMessage[] = [];
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, maxMessages = MAX_TELEGRAM_INBOX_MESSAGES) {
    this.#filePath = filePath;
    this.#maxMessages = Math.max(1, Math.floor(maxMessages));
  }

  async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }

    const saved: unknown = JSON.parse(contents);
    if (
      typeof saved !== "object" ||
      saved === null ||
      !("messages" in saved) ||
      !Array.isArray(saved.messages)
    ) {
      throw new Error("The Telegram inbox file has an invalid format.");
    }
    this.#messages = saved.messages
      .filter(isInboxMessage)
      .slice(-this.#maxMessages);
  }

  async record(entry: TelegramInboxMessage): Promise<void> {
    const message = normalizeMessage(entry);
    const operation = this.#writeQueue.then(async () => {
      if (this.#messages.some((saved) => saved.updateId === message.updateId)) {
        return;
      }

      const nextMessages = [...this.#messages, message].slice(
        -this.#maxMessages,
      );
      await this.#write(nextMessages);
      this.#messages = nextMessages;
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }

  listUsers(limit = 20, offset = 0): TelegramInboxUser[] {
    const users = new Map<number, TelegramInboxUser>();
    for (const message of this.#messages) {
      const user = users.get(message.userId);
      if (user) {
        user.messageCount += 1;
        if (message.receivedAt >= user.lastMessageAt) {
          user.chatId = message.chatId;
          user.firstName = message.firstName;
          user.username = message.username;
          user.lastMessageAt = message.receivedAt;
        }
        continue;
      }
      users.set(message.userId, {
        userId: message.userId,
        chatId: message.chatId,
        firstName: message.firstName,
        username: message.username,
        messageCount: 1,
        lastMessageAt: message.receivedAt,
      });
    }

    return [...users.values()]
      .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }

  getUser(userId: number): TelegramInboxUser | undefined {
    return this.listUsers(this.#messages.length).find(
      (user) => user.userId === userId,
    );
  }

  getMessages(userId: number, limit = 8): TelegramInboxMessage[] {
    const count = Math.max(0, Math.floor(limit));
    if (count === 0) return [];
    return this.#messages
      .filter((message) => message.userId === userId)
      .slice(-count);
  }

  async #write(messages: TelegramInboxMessage[]): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, messages }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
