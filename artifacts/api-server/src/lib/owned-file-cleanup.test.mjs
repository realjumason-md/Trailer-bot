import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeOwnedFile } from "./owned-file-cleanup.ts";

test("removes files under an owned directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owned-file-cleanup-"));
  try {
    const ownedRoot = path.join(root, "bot-api-data");
    const filePath = path.join(ownedRoot, "video.mp4");
    await mkdir(ownedRoot);
    await writeFile(filePath, "video");

    await removeOwnedFile(filePath, [ownedRoot]);

    await assert.rejects(readFile(filePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not remove files outside owned directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owned-file-cleanup-"));
  try {
    const ownedRoot = path.join(root, "bot-api-data");
    const outsideRoot = path.join(root, "bot-api-data-sibling");
    const filePath = path.join(outsideRoot, "video.mp4");
    await mkdir(ownedRoot);
    await mkdir(outsideRoot);
    await writeFile(filePath, "keep");

    await removeOwnedFile(filePath, [ownedRoot]);

    assert.equal(await readFile(filePath, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
