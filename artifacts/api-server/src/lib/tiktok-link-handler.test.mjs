import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadTikTokVideo,
  findTikTokUrl,
  TikTokDownloadError,
  tiktokFailureMessage,
} from "./tiktok-link-handler.ts";

const publicPost =
  "https://www.tiktok.com/@creator/video/1234567890123456789";

test("detects public post URLs and TikTok share links", () => {
  assert.equal(findTikTokUrl(`Try this clip: ${publicPost}.`), publicPost);
  assert.equal(
    findTikTokUrl("https://vm.tiktok.com/ZMxyz123/"),
    "https://vm.tiktok.com/ZMxyz123/",
  );
  assert.equal(
    findTikTokUrl("http://www.tiktok.com/t/ZMxyz123/"),
    "https://www.tiktok.com/t/ZMxyz123/",
  );
});

test("rejects profile pages, lookalike hosts, credentials, and nonstandard ports", () => {
  for (const url of [
    "https://example.com/video/123",
    "https://www.tiktok.com.evil.example/@creator/video/123",
    "https://www.tiktok.com/@creator",
    "https://vm.tiktok.com:8443/ZMxyz123/",
    "https://user@www.tiktok.com/@creator/video/123",
  ]) {
    assert.equal(findTikTokUrl(url), null, url);
  }
});

test("reports missing yt-dlp without exposing downloader output or crashing", async () => {
  const previousPath = process.env["YT_DLP_PATH"];
  process.env["YT_DLP_PATH"] = `/missing-yt-dlp-${randomUUID()}`;
  try {
    await assert.rejects(
      downloadTikTokVideo(
        publicPost,
        path.join(tmpdir(), `${randomUUID()}.mp4`),
        {
          maxBytes: 4 * 1024 * 1024 * 1024,
          signal: new AbortController().signal,
          onProgress: () => undefined,
        },
      ),
      (error) =>
        error instanceof TikTokDownloadError &&
        error.code === "downloader-missing",
    );
  } finally {
    if (previousPath === undefined) delete process.env["YT_DLP_PATH"];
    else process.env["YT_DLP_PATH"] = previousPath;
  }
});

test("runs yt-dlp without cookies, config, bot credentials, or login and rejects a gated post", async () => {
  const testDir = await mkdtemp(path.join(tmpdir(), "tiktok-downloader-test-"));
  const executable = path.join(testDir, "fake-yt-dlp");
  const argumentLog = path.join(testDir, "arguments.txt");
  const environmentLog = path.join(testDir, "environment.txt");
  const previousPath = process.env["YT_DLP_PATH"];
  const previousToken = process.env["TELEGRAM_BOT_TOKEN"];
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argumentLog}"\nenv | sort > "${environmentLog}"\nprintf 'Private video - login required\\n' >&2\nexit 1\n`,
  );
  await chmod(executable, 0o700);
  process.env["YT_DLP_PATH"] = executable;
  process.env["TELEGRAM_BOT_TOKEN"] = "must-not-reach-downloader";
  try {
    await assert.rejects(
      downloadTikTokVideo(
        publicPost,
        path.join(testDir, "video.mp4"),
        {
          maxBytes: 4 * 1024 * 1024 * 1024,
          signal: new AbortController().signal,
          onProgress: () => undefined,
        },
      ),
      (error) =>
        error instanceof TikTokDownloadError && error.code === "public-only",
    );
    const args = await readFile(argumentLog, "utf8");
    const childEnvironment = await readFile(environmentLog, "utf8");
    assert.match(args, /--ignore-config/);
    assert.match(args, /--no-playlist/);
    assert.doesNotMatch(args, /--cookies(?:-from-browser)?/);
    assert.doesNotMatch(childEnvironment, /TELEGRAM_BOT_TOKEN=/);
  } finally {
    if (previousPath === undefined) delete process.env["YT_DLP_PATH"];
    else process.env["YT_DLP_PATH"] = previousPath;
    if (previousToken === undefined) delete process.env["TELEGRAM_BOT_TOKEN"];
    else process.env["TELEGRAM_BOT_TOKEN"] = previousToken;
    await rm(testDir, { recursive: true, force: true });
  }
});

test("limits user-facing errors to safe messages", () => {
  assert.match(
    tiktokFailureMessage(new TikTokDownloadError("public-only")),
    /public TikTok videos.*without signing in/i,
  );
  assert.doesNotMatch(
    tiktokFailureMessage(new Error("extractor output with private data")),
    /extractor output with private data/,
  );
});
