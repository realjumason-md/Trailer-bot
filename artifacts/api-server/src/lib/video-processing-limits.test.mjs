import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compressVideo,
  isTelegramOutputWithinLimit,
  videoLimits,
} from "./video-processing.ts";

async function createSparseFile(filePath, size) {
  const file = await open(filePath, "w");
  try {
    await file.truncate(size);
  } finally {
    await file.close();
  }
}

function processingOptions(inputPath, outputPath) {
  return {
    inputPath,
    outputPath,
    resolution: {
      label: "Original",
      maxWidth: 1280,
      maxHeight: 720,
      preserveSourceDimensions: true,
    },
    onProcess: () => undefined,
    onVideoInfo: () => undefined,
    onProgress: () => undefined,
  };
}

test("accepts a linked-input limit above 4 GB and rejects inputs over 5 GB", async () => {
  assert.equal(videoLimits.maxInputBytes, 5_000_000_000);
  assert.equal(videoLimits.maxInputSizeLabel, "5 GB");
  assert.equal(videoLimits.maxTelegramUploadBytes, 4 * 1024 * 1024 * 1024);

  const testDir = await mkdtemp(path.join(tmpdir(), "video-input-limit-test-"));
  const inputPath = path.join(testDir, "input.mp4");
  const outputPath = path.join(testDir, "output.mp4");

  try {
    await createSparseFile(inputPath, videoLimits.maxInputBytes + 1);
    await assert.rejects(
      compressVideo(processingOptions(inputPath, outputPath)),
      (error) => error?.code === "input_too_large",
    );
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("enforces a strict Telegram-safe output ceiling", () => {
  assert.equal(videoLimits.maxTelegramOutputBytes, 1_900_000_000);
  assert.ok(videoLimits.maxTelegramOutputBytes < 2_000_000_000);
  assert.equal(
    isTelegramOutputWithinLimit(videoLimits.maxTelegramOutputBytes),
    true,
  );
  assert.equal(
    isTelegramOutputWithinLimit(videoLimits.maxTelegramOutputBytes + 1),
    false,
  );
  assert.equal(isTelegramOutputWithinLimit(Number.POSITIVE_INFINITY), false);
});
