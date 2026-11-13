import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadPublicSiteVideo,
  downloadTikTokVideo,
  findTikTokUrl,
  getCookiesRuntimeStatus,
  getVideoSiteName,
  isStreamingManifestUrl,
  publicVideoFailureMessage,
  resolveCookiesFile,
  TikTokDownloadError,
  tiktokFailureMessage,
} from "./tiktok-link-handler.ts";
import { RemoteVideoDownloadError } from "./remote-video-download.ts";

const publicPost = "https://www.tiktok.com/@creator/video/1234567890123456789";

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

test("labels common video sites and identifies HLS/DASH manifests", () => {
  assert.equal(getVideoSiteName("https://youtu.be/example"), "YouTube");
  assert.equal(
    getVideoSiteName("https://www.instagram.com/reel/example"),
    "Instagram",
  );
  assert.equal(
    isStreamingManifestUrl(
      "https://cdn.example.test/stream.m3u8?token=private",
    ),
    true,
  );
  assert.equal(
    isStreamingManifestUrl("https://cdn.example.test/stream?format=mpd"),
    true,
  );
  assert.equal(
    isStreamingManifestUrl(
      "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    ),
    false,
  );
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
        YTDLP_COOKIES_CONTENT: undefined,
      },
      async () => {
        assert.equal(await resolveCookiesFile(), explicitFile);
        assert.equal(await getCookiesRuntimeStatus(), "loaded");
        process.env["YTDLP_COOKIES_FILE"] = directoryPath;
        assert.equal(await resolveCookiesFile(), fallbackFile);
        assert.equal(await getCookiesRuntimeStatus(), "loaded");
        process.env["YTDLP_COOKIES_FILE"] = path.join(testDir, "missing.txt");
        assert.equal(await resolveCookiesFile(), fallbackFile);
        await rm(fallbackFile);
        assert.equal(await resolveCookiesFile(), null);
        assert.equal(await getCookiesRuntimeStatus(), "configured-unavailable");
        delete process.env["YTDLP_COOKIES_FILE"];
        assert.equal(await getCookiesRuntimeStatus(), "not-configured");
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
      downloadTikTokVideo(publicPost, path.join(testDir, "video.mp4"), {
        maxBytes: 4 * 1024 * 1024 * 1024,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
      (error) =>
        error instanceof TikTokDownloadError && error.code === "public-only",
    );
    const args = await readFile(argumentLog, "utf8");
    const childEnvironment = await readFile(environmentLog, "utf8");
    assert.match(args, /--ignore-config/);
    assert.match(args, /--js-runtimes\nnode\n/);
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
    if (previousCookiesFile === undefined)
      delete process.env["YTDLP_COOKIES_FILE"];
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
  const progressEvents = [];
  await writeFile(cookiesFile, "# Netscape HTTP Cookie File\n");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argumentLog}"\nenv | sort > "${environmentLog}"\nprintf '__BOT_YTDLP_PROGRESS__5|10|20\\n' >&2\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then output="$2"; shift 2; else shift; fi\ndone\nintermediate_path=$(printf '%s' "$output" | sed 's/%(ext)s/f137.mp4/')\nvideo_path=$(printf '%s' "$output" | sed 's/%(ext)s/mp4/')\nprintf 'intermediate-video' > "$intermediate_path"\nprintf 'fake-video' > "$video_path"\n`,
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
        onProgress: (downloadedBytes, totalBytes) =>
          progressEvents.push({ downloadedBytes, totalBytes }),
      },
    );
    assert.equal(size, Buffer.byteLength("fake-video"));
    assert.equal(await readFile(destination, "utf8"), "fake-video");
    const args = await readFile(argumentLog, "utf8");
    const childEnvironment = await readFile(environmentLog, "utf8");
    assert.match(args, /--ignore-config/);
    assert.match(args, /--no-playlist/);
    assert.match(args, /--progress\n/);
    assert.match(args, /--progress-template\ndownload:__BOT_YTDLP_PROGRESS__/);
    assert.match(args, /bestvideo\[ext=mp4\]\+bestaudio\[ext=m4a\]/);
    assert.match(args, /--fragment-retries\n3/);
    assert.match(args, /--max-filesize\n4096M/);
    assert.match(args, /--proxy\nhttp:\/\/127\.0\.0\.1:\d+/);
    assert.ok(args.includes(`--cookies\n${cookiesFile}\n`));
    assert.doesNotMatch(childEnvironment, /TELEGRAM_BOT_TOKEN=/);
    assert.doesNotMatch(
      childEnvironment,
      /YTDLP_COOKIES_CONTENT|cookie-content-sentinel/,
    );
    assert.match(childEnvironment, /HTTP_PROXY=http:\/\/127\.0\.0\.1:\d+/);
    assert.ok(
      progressEvents.some(
        (event) => event.downloadedBytes === 5 && event.totalBytes === 10,
      ),
      "should parse byte progress from yt-dlp output",
    );
  } finally {
    if (previousPath === undefined) delete process.env["YT_DLP_PATH"];
    else process.env["YT_DLP_PATH"] = previousPath;
    if (previousToken === undefined) delete process.env["TELEGRAM_BOT_TOKEN"];
    else process.env["TELEGRAM_BOT_TOKEN"] = previousToken;
    if (previousCookiesFile === undefined)
      delete process.env["YTDLP_COOKIES_FILE"];
    else process.env["YTDLP_COOKIES_FILE"] = previousCookiesFile;
    if (previousCookieContent === undefined)
      delete process.env["YTDLP_COOKIES_CONTENT"];
    else process.env["YTDLP_COOKIES_CONTENT"] = previousCookieContent;
    if (previousDataDir === undefined) delete process.env["BOT_DATA_DIR"];
    else process.env["BOT_DATA_DIR"] = previousDataDir;
    await rm(testDir, { recursive: true, force: true });
  }
});

test("classifies yt-dlp failures without exposing raw extractor output", async () => {
  const testDir = await mkdtemp(path.join(tmpdir(), "ytdlp-error-codes-"));
  const executable = path.join(testDir, "fake-yt-dlp");
  const previousPath = process.env["YT_DLP_PATH"];
  const previousCookiesFile = process.env["YTDLP_COOKIES_FILE"];
  const previousDataDir = process.env["BOT_DATA_DIR"];
  process.env["YT_DLP_PATH"] = executable;
  delete process.env["YTDLP_COOKIES_FILE"];
  delete process.env["BOT_DATA_DIR"];
  const cases = [
    ["ERROR: This video is not available in your country", "geo-blocked"],
    ["ERROR: DRM protected media", "drm-protected"],
    ["ERROR: HTTP Error 403: AccessDenied", "access-denied"],
    ["ERROR: HTTP Error 429: Too Many Requests", "rate-limited"],
    [
      "ERROR: Unsupported URL: https://unsupported.example/video",
      "extractor-missing",
    ],
    ["ERROR: Requested format is not available", "format-unavailable"],
    ["ERROR: HTTP Error 503: Service Unavailable", "temporary-failure"],
  ];
  try {
    for (const [stderr, expectedCode] of cases) {
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' '${stderr}' >&2\nexit 1\n`,
      );
      await chmod(executable, 0o700);
      await assert.rejects(
        downloadPublicSiteVideo(
          "https://1.1.1.1/video/example",
          path.join(testDir, `${expectedCode}.mp4`),
          {
            maxBytes: 4 * 1024 * 1024 * 1024,
            signal: new AbortController().signal,
            onProgress: () => undefined,
          },
        ),
        (error) =>
          error instanceof TikTokDownloadError && error.code === expectedCode,
        stderr,
      );
    }
  } finally {
    if (previousPath === undefined) delete process.env["YT_DLP_PATH"];
    else process.env["YT_DLP_PATH"] = previousPath;
    if (previousCookiesFile === undefined)
      delete process.env["YTDLP_COOKIES_FILE"];
    else process.env["YTDLP_COOKIES_FILE"] = previousCookiesFile;
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
  assert.match(
    publicVideoFailureMessage(
      new TikTokDownloadError("access-denied"),
      "Google Cloud Storage",
    ),
    /Google Cloud Storage.*refused public access/i,
  );
  assert.doesNotMatch(
    publicVideoFailureMessage(new Error("extractor output with private data")),
    /extractor output with private data/,
  );
});
