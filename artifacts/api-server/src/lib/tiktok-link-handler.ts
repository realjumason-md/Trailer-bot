import { spawn } from "node:child_process";
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

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

export type TikTokDownloadErrorCode =
  | "invalid-link"
  | "too-large"
  | "timeout"
  | "cancelled"
  | "public-only"
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

export function tiktokFailureMessage(error: unknown): string {
  const code =
    error instanceof TikTokDownloadError ? error.code : "download-failed";
  switch (code) {
    case "too-large":
      return "That TikTok video is larger than this bot's 4 GB input limit.";
    case "timeout":
      return "The TikTok download timed out. Try another public video link.";
    case "cancelled":
      return "TikTok video download cancelled.";
    case "public-only":
      return "I can only fetch public TikTok videos that are accessible without signing in.";
    case "downloader-missing":
      return "TikTok downloads are unavailable because yt-dlp is missing from this deployment.";
    case "unsupported-format":
      return "TikTok did not provide a supported MP4 video for that post.";
    default:
      return "I couldn't fetch that TikTok video. It may be private, unavailable, or blocked.";
  }
}

async function runYtDlp(
  url: string,
  outputDir: string,
  options: {
    maxBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress: (bytes: number) => void;
  },
): Promise<void> {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-progress",
    "--socket-timeout",
    "30",
    "--retries",
    "1",
    "--format",
    "best[ext=mp4]/best",
    "--merge-output-format",
    "mp4",
    "--max-filesize",
    `${Math.floor(options.maxBytes / (1024 * 1024))}M`,
    "--output",
    path.join(outputDir, "tiktok.%(ext)s"),
    url,
  ];
  if (options.signal.aborted) throw new TikTokDownloadError("cancelled");

  await new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(process.env["YT_DLP_PATH"] || "yt-dlp", args, {
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: outputDir,
          TMPDIR: outputDir,
          SSL_CERT_FILE:
            process.env["SSL_CERT_FILE"] ??
            process.env["NIX_SSL_CERT_FILE"] ??
            "/etc/ssl/certs/ca-certificates.crt",
          SSL_CERT_DIR: process.env["SSL_CERT_DIR"] ?? "/etc/ssl/certs",
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new TikTokDownloadError("downloader-missing"));
      return;
    }

    let stderr = "";
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
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const sizeTimer = setInterval(() => void checkOutputSize(), 500);

    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.toString().slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });
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
        const loginRequired =
          /login required|private video|sign[- ]?in required|age[- ]?restricted/i.test(
            stderr,
          );
        finish(
          new TikTokDownloadError(
            loginRequired ? "public-only" : "download-failed",
          ),
        );
      } else {
        finish();
      }
    });
  });
}

export async function downloadTikTokVideo(
  inputUrl: string,
  destination: string,
  options: {
    maxBytes: number;
    signal: AbortSignal;
    onProgress: (bytes: number) => void;
    timeoutMs?: number;
  },
): Promise<number> {
  const url = findTikTokUrl(inputUrl);
  if (!url) throw new TikTokDownloadError("invalid-link");

  const outputDir = await mkdtemp(
    path.join(path.dirname(destination), ".tiktok-download-"),
  );
  try {
    await runYtDlp(url, outputDir, {
      ...options,
      timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    });
    const video = (await readdir(outputDir)).find((name) => /\.mp4$/iu.test(name));
    if (!video) throw new TikTokDownloadError("unsupported-format");
    const sourcePath = path.join(outputDir, video);
    const result = await stat(sourcePath);
    if (!result.size) throw new TikTokDownloadError("download-failed");
    if (result.size > options.maxBytes) throw new TikTokDownloadError("too-large");
    await rename(sourcePath, destination);
    return result.size;
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    if (error instanceof TikTokDownloadError) throw error;
    if (options.signal.aborted) throw new TikTokDownloadError("cancelled");
    throw new TikTokDownloadError("download-failed");
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
