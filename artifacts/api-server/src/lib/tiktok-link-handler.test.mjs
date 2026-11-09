import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadPublicSiteVideo,
  downloadTikTokVideo,
  findTikTokUrl,
  publicVideoFailureMessage,
  resolveCookiesFile,
  TikTokDownloadError,
  tiktokFailureMessage,
} from "./tiktok-link-handler.ts";
import { RemoteVideoDownloadError } from "./remote-video-download.ts";

const publicPost =
  "https://www.tiktok.com/@creator/video/1234567890123456789";

async function withEnvironment(updates, callback) {
  const previous = new Map(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

test("resolves readable cookie files and ignores directories or missing paths", async () => {
  const testDir = await mkdtemp(path.join(tmpdir(), "ytdlp-cookies-test-"));
  const dataDir = path.join(testDir, "data");
  const fallbackFile = path.join(dataDir, "cookies.txt");
  const explicitFile = path.join(testDir, "explicit-cookies.txt");
  const directoryPath = path.join(testDir, "not-a-cookie-file");
  await mkdir(dataDir, { recursive: true });
  await mkdir(directoryPath, { recursive: true });
  await writeFile(fallbackFile, "# Netscape HTTP Cookie File\n");
  await writeFile(explicitFile, "# Netscape HTTP Cookie File\n");
  try {
    await withEnvironment(
      {
        BOT_DATA_DIR: dataDir,
        YTDLP_COOKIES_FILE: explicitFile,
      },
      async () => {
        assert.equal(await resolveCookiesFile(), explicitFile);
        process.env["YTDLP_COOKIES_FILE"] = directoryPath;
        assert.equal(await resolveCookiesFile(), fallbackFile);
        process.env["YTDLP_COOKIES_FILE"] = path.join(testDir, "missing.txt");
        assert.equal(await resolveCookiesFile(), fallbackFile);
        await rm(fallbackFile);
        assert.equal(await resolveCookiesFile(), null);
      },
    );
  } finally {
    await rm(testDir, { recursive: true, force: true });
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
  const previousCookiesFile = process.env["YTDLP_COOKIES_FILE"];
  const previousDataDir = process.env["BOT_DATA_DIR"];
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argumentLog}"\nenv | sort > "${environmentLog}"\nprintf 'Private video - login required\\n' >&2\nexit 1\n`,
  );
  await chmod(executable, 0o700);
  process.env["YT_DLP_PATH"] = executable;
  process.env["TELEGRAM_BOT_TOKEN"] = "must-not-reach-downloader";
  delete process.env["YTDLP_COOKIES_FILE"];
  delete process.env["BOT_DATA_DIR"];
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
    assert.match(args, /--proxy\nhttp:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(args, /--cookies(?:-from-browser)?/);
    assert.doesNotMatch(childEnvironment, /TELEGRAM_BOT_TOKEN=/);
    assert.match(childEnvironment, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    if (previousPath === undefined) delete process.env["YT_DLP_PATH"];
    else process.env["YT_DLP_PATH"] = previousPath;
    if (previousToken === undefined) delete process.env["TELEGRAM_BOT_TOKEN"];
    else process.env["TELEGRAM_BOT_TOKEN"] = previousToken;
    if (previousCookiesFile === undefined) delete process.env["YTDLP_COOKIES_FILE"];
    else process.env["YTDLP_COOKIES_FILE"] = previousCookiesFile;
    if (previousDataDir === undefined) delete process.env["BOT_DATA_DIR"];
    else process.env["BOT_DATA_DIR"] = previousDataDir;
    await rm(testDir, { recursive: true, force: true });
  }
});

test("extracts public video pages through the guarded yt-dlp proxy", async () => {
  const testDir = await mkdtemp(path.join(tmpdir(), "public-site-downloader-"));
  const executable = path.join(testDir, "fake-yt-dlp");
  const argumentLog = path.join(testDir, "arguments.txt");
  const environmentLog = path.join(testDir, "environment.txt");
  const cookiesFile = path.join(testDir, "cookies.txt");
  const previousPath = process.env["YT_DLP_PATH"];
  const previousToken = process.env["TELEGRAM_BOT_TOKEN"];
  const previousCookiesFile = process.env["YTDLP_COOKIES_FILE"];
  const previousCookieContent = process.env["YTDLP_COOKIES_CONTENT"];
  const previousDataDir = process.env["BOT_DATA_DIR"];
  await writeFile(cookiesFile, "# Netscape HTTP Cookie File\n");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argumentLog}"\nenv | sort > "${environmentLog}"\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then output="$2"; shift 2; else shift; fi\ndone\nvideo_path=$(printf '%s' "$output" | sed 's/%(ext)s/mp4/')\nprintf 'fake-video' > "$video_path"\n`,
  );
  await chmod(executable, 0o700);
  process.env["YT_DLP_PATH"] = executable;
  process.env["TELEGRAM_BOT_TOKEN"] = "must-not-reach-downloader";
  process.env["YTDLP_COOKIES_FILE"] = cookiesFile;
  process.env["YTDLP_COOKIES_CONTENT"] = "cookie-content-sentinel";
  process.env["BOT_DATA_DIR"] = testDir;
  const destination = path.join(testDir, "downloaded.mp4");
  try {
    const size = await downloadPublicSiteVideo(
      "https://1.1.1.1/watch/example",
      destination,
      {
        maxBytes: 4 * 1024 * 1024 * 1024,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      },
    );
    assert.equal(size, Buffer.byteLength("fake-video"));
    assert.equal(await readFile(destination, "utf8"), "fake-video");
    const args = await readFile(argumentLog, "utf8");
    const childEnvironment = await readFile(environmentLog, "utf8");
    assert.match(args, /--ignore-config/);
    assert.match(args, /--no-playlist/);
    assert.match(args, /--max-filesize\n4096M/);
    assert.match(args, /--proxy\nhttp:\/\/127\.0\.0\.1:\d+/);
    assert.ok(args.includes(`--cookies\n${cookiesFile}\n`));
    assert.doesNotMatch(childEnvironment, /TELEGRAM_BOT_TOKEN=/);
    assert.doesNotMatch(childEnvironment, /YTDLP_COOKIES_CONTENT|cookie-content-sentinel/);
    assert.match(childEnvironment, /HTTP_PROXY=http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    if (previousPath === undefined) delete process.env["YT_DLP_PATH"];
    else process.env["YT_DLP_PATH"] = previousPath;
    if (previousToken === undefined) delete process.env["TELEGRAM_BOT_TOKEN"];
    else process.env["TELEGRAM_BOT_TOKEN"] = previousToken;
    if (previousCookiesFile === undefined) delete process.env["YTDLP_COOKIES_FILE"];
    else process.env["YTDLP_COOKIES_FILE"] = previousCookiesFile;
    if (previousCookieContent === undefined) delete process.env["YTDLP_COOKIES_CONTENT"];
    else process.env["YTDLP_COOKIES_CONTENT"] = previousCookieContent;
    if (previousDataDir === undefined) delete process.env["BOT_DATA_DIR"];
    else process.env["BOT_DATA_DIR"] = previousDataDir;
    await rm(testDir, { recursive: true, force: true });
  }
});

test("rejects private site URLs before starting yt-dlp", async () => {
  await assert.rejects(
    downloadPublicSiteVideo(
      "http://127.0.0.1/private-video",
      path.join(tmpdir(), `${randomUUID()}.mp4`),
      {
        maxBytes: 4 * 1024 * 1024 * 1024,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      },
    ),
    RemoteVideoDownloadError,
  );
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
  assert.match(
    publicVideoFailureMessage(new TikTokDownloadError("public-only")),
    /public.*without signing in/i,
  );
  assert.doesNotMatch(
    publicVideoFailureMessage(new Error("extractor output with private data")),
    /extractor output with private data/,
  );
});
