import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TelegramInboxStore } from "./telegram-inbox.ts";

let temporaryDirectory;

test.beforeEach(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "telegram-inbox-test-"),
  );
});

test.afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function message(updateId, userId, receivedAt, text = "hello") {
  return {
    updateId,
    userId,
    chatId: userId,
    firstName: `User ${userId}`,
    contentType: "text",
    text,
    receivedAt,
  };
}

test("persists recent users and messages, and ignores duplicate updates", async () => {
  const filePath = path.join(temporaryDirectory, "inbox.json");
  const store = new TelegramInboxStore(filePath);
  await store.load();
  await store.record(message(1, 42, 100, "first message"));
  await store.record(message(2, 42, 200, "second message"));
  await store.record(message(2, 42, 200, "duplicate update"));

  const reloaded = new TelegramInboxStore(filePath);
  await reloaded.load();

  assert.deepEqual(
    reloaded.getMessages(42).map((entry) => entry.text),
    ["first message", "second message"],
  );
  assert.deepEqual(reloaded.listUsers(), [
    {
      userId: 42,
      chatId: 42,
      firstName: "User 42",
      username: undefined,
      messageCount: 2,
      lastMessageAt: 200,
    },
  ]);
});

test("keeps only the configured number of recent messages", async () => {
  const store = new TelegramInboxStore(
    path.join(temporaryDirectory, "inbox.json"),
    2,
  );
  await store.load();
  await store.record(message(1, 42, 100, "oldest"));
  await store.record(message(2, 43, 200, "middle"));
  await store.record(message(3, 42, 300, "newest"));

  assert.deepEqual(
    store.getMessages(42).map((entry) => entry.text),
    ["newest"],
  );
  assert.deepEqual(
    store.listUsers().map((user) => user.userId),
    [42, 43],
  );
});
