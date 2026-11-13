import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  parseDownloadUrl,
  RemoteVideoDownloadError,
  resolvePublicAddress,
} from "./remote-video-download.ts";
import { startPublicEgressProxy } from "./public-egress-proxy.ts";

const POST_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);
const SHORT_LINK_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);
const MAX_STDERR_CHARS = 4_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000;
const SITE_DOWNLOAD_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
const SUPPORTED_VIDEO_EXTENSION =
  /\.(?:mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|3gp|ts|flv)$/iu;

export type TikTokDownloadErrorCode =
  | "invalid-link"
  | "too-large"
  | "timeout"
  | "cancelled"
  | "public-only"
  | "auth-required"
  | "geo-blocked"
  | "drm-protected"
  | "access-denied"
  | "extractor-missing"
  | "rate-limited"
  | "format-unavailable"
  | "temporary-failure"
  | "downloader-missing"
  | "unsupported-format"
  | "download-failed";

export class TikTokDownloadError extends Error {
  readonly code: TikTokDownloadErrorCode;

  constructor(code: TikTokDownloadErrorCode) {
    super(code);
    this.name = "TikTokDownloadError";
    this.code = code;
  }
}

function isPostPath(url: URL): boolean {
  if (SHORT_LINK_HOSTS.has(url.hostname)) {
    return /^\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname);
  }
  return (
    /^\/@[a-zA-Z0-9._-]+\/video\/\d+\/?$/.test(url.pathname) ||
    /^\/t\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) ||
    /^\/v\/\d+\/?$/.test(url.pathname)
  );
}

export function findTikTokUrl(text = ""): string | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  for (const candidate of candidates) {
    const value = candidate.replace(/[),.!;:\]}]+$/u, "");
    if (value.length > 2_048) continue;
    try {
      const url = new URL(value);
      const standardPort =
        !url.port ||
        (url.protocol === "https:" && url.port === "443") ||
        (url.protocol === "http:" && url.port === "80");
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !POST_HOSTS.has(url.hostname.toLowerCase()) ||
        url.username ||
        url.password ||
        !standardPort ||
        !isPostPath(url)
      ) {
        continue;
      }
      url.protocol = "https:";
      url.hash = "";
      return url.toString();
    } catch {
      // Ignore malformed and non-TikTok links.
    }
  }
  return null;
}

const SITE_HOSTS: Array<{ label: string; hosts: string[] }> = [
  { label: "TikTok", hosts: ["tiktok.com"] },
  {
    label: "YouTube",
    hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  },
  { label: "Instagram", hosts: ["instagram.com"] },
  { label: "Facebook", hosts: ["facebook.com", "fb.watch"] },
  { label: "X", hosts: ["x.com", "twitter.com", "t.co"] },
  { label: "Reddit", hosts: ["reddit.com", "redd.it"] },
  { label: "Vimeo", hosts: ["vimeo.com"] },
];

export function getVideoSiteName(inputUrl: string): string {
  try {
    const hostname = new URL(inputUrl).hostname.toLowerCase();
    for (const site of SITE_HOSTS) {
      if (
        site.hosts.some(
          (host) => hostname === host || hostname.endsWith(`.${host}`),
        )
      ) {
        return site.label;
      }
    }
    return hostname || "video page";
  } catch {
    return "video page";
  }
}

export function isStreamingManifestUrl(inputUrl: string): boolean {
  try {
    const url = new URL(inputUrl);
    if (/\.(?:m3u8|mpd)$/iu.test(url.pathname)) return true;
    return ["format", "type", "manifest"].some((key) =>
      /^(?:hls|dash|m3u8|mpd)$/iu.test(url.searchParams.get(key) ?? ""),
    );
  } catch {
    return false;
  }
}

/** Returns a readable cookies path if configured and present; otherwise null. */
export async function resolveCookiesFile(): Promise<string | null> {
  const fromEnv = process.env["YTDLP_COOKIES_FILE"]?.trim();
  const candidates: string[] = [];
  if (fromEnv) candidates.push(fromEnv);

  const dataDir = process.env["BOT_DATA_DIR"]?.trim();
  if (dataDir) {
    candidates.push(path.join(dataDir, "cookies.txt"));
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

export async function getCookiesRuntimeStatus(): Promise<
  "loaded" | "configured-unavailable" | "not-configured"
> {
  if (await resolveCookiesFile()) return "loaded";
  if (
    process.env["YTDLP_COOKIES_FILE"]?.trim() ||
    process.env["YTDLP_COOKIES_CONTENT"]?.trim()
  ) {
    return "configured-unavailable";
  }
  return "not-configured";
}

export function tiktokFailureMessage(error: unknown): string {
  const code =
    error instanceof TikTokDownloadError ? error.code : "download-failed";
  switch (code) {
    case "too-large":
      return "That TikTok video is larger than this bot's 4 GB input limit.";
    case "timeout":
      return "The TikTok download timed out. Try another video link.";
    case "cancelled":
      return "TikTok video download cancelled.";
    case "public-only":
      return "I can fetch public TikTok videos without signing in. For supported videos your account can view, a configured cookies file may help.";
    case "auth-required":
      return "That TikTok video needs a signed-in session. Update YTDLP_COOKIES_FILE with a fresh Netscape cookies.txt from an account that can view it.";
    case "geo-blocked":
      return "That TikTok video isn't available from this server's region.";
    case "drm-protected":
      return "That TikTok video is DRM-protected, which this bot cannot download.";
    case "access-denied":
      return "The TikTok link refused public access or the video is no longer available. Check that the link can be opened without signing in.";
    case "extractor-missing":
      return "yt-dlp does not currently recognize that TikTok page. Try again after the site's extractor is updated.";
    case "rate-limited":
      return "TikTok temporarily rate-limited this request. Wait a bit, then try again.";
    case "format-unavailable":
    case "downloader-missing":
      return code === "downloader-missing"
        ? "TikTok downloads are unavailable because yt-dlp is missing from this deployment."
        : "TikTok did not provide a video format this bot can process.";
    case "temporary-failure":
      return "TikTok is temporarily unavailable. Wait a bit, then try again.";
    case "unsupported-format":
      return "TikTok did not provide a supported video format for that post.";
    default:
      return "I couldn't fetch that TikTok video. It may be private, unavailable, or blocked.";
  }
}

export function publicVideoFailureMessage(
  error: unknown,
  siteName = "video page",
): string {
  const pageLabel =
    siteName === "video page" ? "video page" : `${siteName} page`;
  const code =
    error instanceof TikTokDownloadError ? error.code : "download-failed";
  switch (code) {
    case "too-large":
      return "That video is larger than this bot's 4 GB input limit.";
    case "timeout":
      return "The video download timed out. Try another link.";
    case "cancelled":
      return "Video download cancelled.";
    case "public-only":
      return `I couldn't access that ${pageLabel}. It may be private, age-restricted, or require a sign-in. I can only fetch public videos without signing in; a cookies file only works for content your account is allowed to view.`;
    case "auth-required":
      return `That ${pageLabel} needs a signed-in session. Provide a fresh Netscape cookies.txt through YTDLP_COOKIES_FILE or YTDLP_COOKIES_CONTENT, using an account allowed to view it.`;
    case "geo-blocked":
      return `That video from ${siteName} isn't available from this server's region.`;
    case "drm-protected":
      return "This video is DRM-protected, which the bot does not support.";
    case "access-denied":
      return `The ${pageLabel} link refused public access or the video is no longer available. Check that the link can be opened without signing in.`;
    case "extractor-missing":
      return `yt-dlp does not currently recognize a supported extractor for that ${pageLabel}.`;
    case "rate-limited":
      return `${siteName} temporarily rate-limited this request. Wait a bit, then try again.`;
    case "format-unavailable":
    case "downloader-missing":
      return code === "downloader-missing"
        ? "Public video-page downloads are unavailable because yt-dlp is missing from this deployment."
        : `That ${pageLabel} did not provide a video format this bot can process.`;
    case "temporary-failure":
      return `The ${siteName} download service appears to be temporarily unavailable. Try again later.`;
    case "unsupported-format":
      return "That page did not provide a supported video format.";
    case "invalid-link":
      return "Send a public HTTP or HTTPS video link.";
    default:
      return "I couldn't extract a video from that page. It may be unsupported, unavailable, or blocking automated downloads.";
  }
}

function parseYtDlpProgressLine(
  line: string,
): { downloadedBytes: number; totalBytes?: number } | null {
  const match = line.match(
    /__BOT_YTDLP_PROGRESS__(\d+)\|([^|\s]+)\|([^|\s]+)/u,
  );
  if (!match) return null;
  const downloadedBytes = Number(match[1]);
  const totalBytes = Number(match[2]);
  const estimatedTotalBytes = Number(match[3]);
  if (!Number.isSafeInteger(downloadedBytes) || downloadedBytes < 0) {
    return null;
  }
  const usableTotal =
    Number.isSafeInteger(totalBytes) && totalBytes > 0
      ? totalBytes
      : Number.isSafeInteger(estimatedTotalBytes) && estimatedTotalBytes > 0
        ? estimatedTotalBytes
        : undefined;
  return usableTotal == null
    ? { downloadedBytes }
    : { downloadedBytes, totalBytes: usableTotal };
}

function classifyYtDlpFailure(
  stderr: string,
  cookiesFile: string | null,
): TikTokDownloadErrorCode {
  if (
    /drm[-\s]?protected|protected by drm|requires? a drm license/i.test(stderr)
  ) {
    return "drm-protected";
  }
  if (
    /not available (?:from|in) your (?:country|location)|unavailable in your region|geo[-\s]?restricted|blocked in your country|client's country/i.test(
      stderr,
    )
  ) {
    return "geo-blocked";
  }
  if (
    /http(?:s)? error:?\s*429|\b429\b|too many requests|rate[-\s]?limit/i.test(
      stderr,
    )
  ) {
    return "rate-limited";
  }
  if (
    /unsupported url|no suitable extractor|no extractor found|extractor.{0,40}(?:not found|unsupported)/i.test(
      stderr,
    )
  ) {
    return "extractor-missing";
  }
  if (
    /requested format.{0,40}not available|no video formats found|no suitable formats|format selection failed/i.test(
      stderr,
    )
  ) {
    return "format-unavailable";
  }
  if (
    /login required|private video|sign[- ]?in required|age[- ]?restricted|cookies? (?:are )?needed/i.test(
      stderr,
    )
  ) {
    return cookiesFile ? "auth-required" : "public-only";
  }
  if (
    /http(?:s)? error:?\s*(?:401|403)|\bforbidden\b|access[\s_-]?denied/i.test(
      stderr,
    )
  ) {
    return "access-denied";
  }
  if (
    /http(?:s)? error:?\s*5\d\d|service unavailable|temporarily unavailable|connection (?:reset|refused)|timed? out/i.test(
      stderr,
    )
  ) {
    return "temporary-failure";
  }
  return "download-failed";
}

async function findDownloadedVideo(
  outputDir: string,
  outputBaseName: string,
): Promise<string | undefined> {
  const entries = await readdir(outputDir, { withFileTypes: true });
  const candidates = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(`${outputBaseName}.`) &&
        SUPPORTED_VIDEO_EXTENSION.test(entry.name),
    )
    .map((entry) => entry.name);
  const mergedOutput = candidates.find(
    (name) => name === `${outputBaseName}${path.extname(name)}`,
  );
  return mergedOutput ?? candidates[0];
}

async function runYtDlp(
  url: string,
  outputDir: string,
  outputBaseName: string,
  options: {
    maxBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress: (bytes: number, totalBytes?: number) => void;
  },
): Promise<void> {
  const proxy = await startPublicEgressProxy();
  try {
    if (options.signal.aborted) throw new TikTokDownloadError("cancelled");

    const args = [
      "--ignore-config",
      "--js-runtimes",
      "node",
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--progress",
      "--progress-template",
      "download:__BOT_YTDLP_PROGRESS__%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s",
      "--socket-timeout",
      "30",
      "--retries",
      "3",
      "--fragment-retries",
      "3",
      "--file-access-retries",
      "2",
      "--proxy",
      proxy.url,
      "--format",
      "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best",
      "--merge-output-format",
      "mp4",
      "--max-filesize",
      `${Math.floor(options.maxBytes / (1024 * 1024))}M`,
      "--output",
      path.join(outputDir, `${outputBaseName}.%(ext)s`),
    ];

    const cookiesFile = await resolveCookiesFile();
    if (cookiesFile) {
      args.push("--cookies", cookiesFile);
    }

    args.push(url);

    await new Promise<void>((resolve, reject) => {
      let child;
      try {
        child = spawn(process.env["YT_DLP_PATH"] || "yt-dlp", args, {
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: outputDir,
            TMPDIR: outputDir,
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            http_proxy: proxy.url,
            https_proxy: proxy.url,
            NO_PROXY: "",
            no_proxy: "",
            SSL_CERT_FILE:
              process.env["SSL_CERT_FILE"] ??
              process.env["NIX_SSL_CERT_FILE"] ??
              "/etc/ssl/certs/ca-certificates.crt",
            SSL_CERT_DIR: process.env["SSL_CERT_DIR"] ?? "/etc/ssl/certs",
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        reject(new TikTokDownloadError("downloader-missing"));
        return;
      }

      let stderr = "";
      let stdoutRemainder = "";
      let stderrRemainder = "";
      let settled = false;
      let timedOut = false;
      let tooLarge = false;
      let cancelled = false;
      let pendingSizeCheck: Promise<void> | null = null;
      const finish = (error?: TikTokDownloadError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearInterval(sizeTimer);
        options.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const checkOutputSize = (): Promise<void> => {
        if (pendingSizeCheck) return pendingSizeCheck;
        pendingSizeCheck = (async () => {
          try {
            const files = await readdir(outputDir, { withFileTypes: true });
            let totalBytes = 0;
            for (const file of files) {
              if (!file.isFile()) continue;
              totalBytes += (await stat(path.join(outputDir, file.name))).size;
            }
            try {
              options.onProgress(totalBytes);
            } catch {
              // A progress notification must not interrupt the download.
            }
            if (totalBytes > options.maxBytes) {
              tooLarge = true;
              child.kill("SIGKILL");
            }
          } catch {
            // The output directory may not contain a file until extraction starts.
          }
        })().finally(() => {
          pendingSizeCheck = null;
        });
        return pendingSizeCheck;
      };
      const onAbort = (): void => {
        cancelled = true;
        child.kill("SIGKILL");
      };
      const consumeOutput = (
        chunk: Buffer,
        stream: "stdout" | "stderr",
      ): void => {
        const text = chunk.toString();
        if (stream === "stderr") {
          stderr = `${stderr}${text}`.slice(-MAX_STDERR_CHARS);
        }
        const combined =
          (stream === "stdout" ? stdoutRemainder : stderrRemainder) + text;
        const lines = combined.split(/\r\n|\n|\r/u);
        const remainder = lines.pop() ?? "";
        if (stream === "stdout") stdoutRemainder = remainder;
        else stderrRemainder = remainder;
        for (const line of lines) {
          const progress = parseYtDlpProgressLine(line);
          if (!progress) continue;
          try {
            options.onProgress(progress.downloadedBytes, progress.totalBytes);
          } catch {
            // Progress reporting must not interrupt the download.
          }
        }
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      const sizeTimer = setInterval(() => void checkOutputSize(), 500);

      options.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) =>
        consumeOutput(chunk, "stdout"),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        consumeOutput(chunk, "stderr"),
      );
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish(
          new TikTokDownloadError(
            error.code === "ENOENT" ? "downloader-missing" : "download-failed",
          ),
        );
      });
      child.once("close", async (code) => {
        if (settled) return;
        clearTimeout(timeoutTimer);
        clearInterval(sizeTimer);
        if (pendingSizeCheck) await pendingSizeCheck;
        await checkOutputSize();
        if (tooLarge) {
          finish(new TikTokDownloadError("too-large"));
        } else if (cancelled || options.signal.aborted) {
          finish(new TikTokDownloadError("cancelled"));
        } else if (timedOut) {
          finish(new TikTokDownloadError("timeout"));
        } else if (code !== 0) {
          finish(
            new TikTokDownloadError(classifyYtDlpFailure(stderr, cookiesFile)),
          );
        } else {
          finish();
        }
      });
    });
  } finally {
    await proxy.close().catch(() => undefined);
  }
}

export async function downloadTikTokVideo(
  inputUrl: string,
  destination: string,
  options: {
    maxBytes: number;
    signal: AbortSignal;
    onProgress: (bytes: number, totalBytes?: number) => void;
    timeoutMs?: number;
  },
): Promise<number> {
  const url = findTikTokUrl(inputUrl);
  if (!url) throw new TikTokDownloadError("invalid-link");

  const outputDir = await mkdtemp(
    path.join(path.dirname(destination), ".tiktok-download-"),
  );
  try {
    await runYtDlp(url, outputDir, "tiktok", {
      ...options,
      timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    });
    const video = await findDownloadedVideo(outputDir, "tiktok");
    if (!video) throw new TikTokDownloadError("unsupported-format");
    const sourcePath = path.join(outputDir, video);
    const result = await stat(sourcePath);
    if (!result.size) throw new TikTokDownloadError("download-failed");
    if (result.size > options.maxBytes)
      throw new TikTokDownloadError("too-large");
    await rename(sourcePath, destination);
    return result.size;
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    if (error instanceof TikTokDownloadError) throw error;
    if (options.signal.aborted) throw new TikTokDownloadError("cancelled");
    throw new TikTokDownloadError("download-failed");
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export async function downloadPublicSiteVideo(
  inputUrl: string,
  destination: string,
  options: {
    maxBytes: number;
    signal: AbortSignal;
    onProgress: (bytes: number, totalBytes?: number) => void;
    timeoutMs?: number;
  },
): Promise<number> {
  let url: URL;
  try {
    url = parseDownloadUrl(inputUrl);
    await resolvePublicAddress(url);
  } catch (error) {
    if (error instanceof RemoteVideoDownloadError) throw error;
    throw new TikTokDownloadError("invalid-link");
  }

  const outputDir = await mkdtemp(
    path.join(path.dirname(destination), ".site-video-download-"),
  );
  try {
    await runYtDlp(url.toString(), outputDir, "video", {
      ...options,
      timeoutMs: options.timeoutMs ?? SITE_DOWNLOAD_TIMEOUT_MS,
    });
    const video = await findDownloadedVideo(outputDir, "video");
    if (!video) throw new TikTokDownloadError("unsupported-format");
    const sourcePath = path.join(outputDir, video);
    const result = await stat(sourcePath);
    if (!result.size) throw new TikTokDownloadError("download-failed");
    if (result.size > options.maxBytes)
      throw new TikTokDownloadError("too-large");
    await rename(sourcePath, destination);
    return result.size;
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    if (
      error instanceof TikTokDownloadError ||
      error instanceof RemoteVideoDownloadError
    ) {
      throw error;
    }
    if (options.signal.aborted) throw new TikTokDownloadError("cancelled");
    throw new TikTokDownloadError("download-failed");
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
