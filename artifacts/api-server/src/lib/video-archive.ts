import { spawn } from "node:child_process";
import { open, stat, unlink } from "node:fs/promises";

const MAX_EXPANSION_RATIO = 100;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_STDERR_CHARS = 2_000;
const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];

const PYTHON_ZIP_EXTRACTOR = String.raw`import stat
import sys
import zipfile

source_path, destination_path = sys.argv[1], sys.argv[2]
max_bytes = int(sys.argv[3])
supported_extensions = {
    ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi",
    ".mpeg", ".mpg", ".3gp", ".ts", ".flv",
}

def fail(reason):
    sys.stderr.write("__VIDEO_ARCHIVE_ERROR__:" + reason + "\n")
    sys.stderr.flush()
    sys.exit(2)

try:
    with zipfile.ZipFile(source_path, "r") as archive:
        candidates = []
        too_large = False
        encrypted = False
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            file_mode = (entry.external_attr >> 16) & 0o170000
            if file_mode == stat.S_IFLNK:
                continue
            leaf_name = entry.filename.rsplit("/", 1)[-1]
            extension = "." + leaf_name.rsplit(".", 1)[-1].lower() if "." in leaf_name else ""
            if extension not in supported_extensions or entry.file_size <= 0:
                continue
            if entry.flag_bits & 1:
                encrypted = True
                continue
            if entry.file_size > max_bytes:
                too_large = True
                continue
            if entry.file_size > max(1, entry.compress_size) * ${MAX_EXPANSION_RATIO}:
                too_large = True
                continue
            candidates.append(entry)

        if not candidates:
            if too_large:
                fail("too-large")
            if encrypted:
                fail("encrypted")
            fail("no-video")

        selected = max(candidates, key=lambda entry: entry.file_size)
        leaf_name = selected.filename.replace("\\", "/").rsplit("/", 1)[-1]
        leaf_name = "".join(character for character in leaf_name if ord(character) >= 32 and ord(character) != 127)
        sys.stdout.write("__VIDEO_ARCHIVE_FILENAME__" + leaf_name + "\n")
        sys.stdout.flush()
        written = 0
        next_report = 1024 * 1024
        with archive.open(selected, "r") as source, open(destination_path, "xb") as destination:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    fail("too-large")
                destination.write(chunk)
                if written >= next_report or written == selected.file_size:
                    sys.stdout.write(
                        "__VIDEO_ARCHIVE_PROGRESS__" + str(written) + "|" +
                        str(selected.file_size) + "\n"
                    )
                    sys.stdout.flush()
                    next_report = written + 1024 * 1024
        if written != selected.file_size:
            fail("invalid")
except zipfile.BadZipFile:
    fail("invalid")
except NotImplementedError:
    fail("unsupported")
except Exception:
    fail("invalid")
`;

export type VideoArchiveErrorCode =
  | "invalid"
  | "no-video"
  | "too-large"
  | "encrypted"
  | "unsupported"
  | "timeout"
  | "cancelled"
  | "tool-missing"
  | "failed";

export class VideoArchiveError extends Error {
  constructor(readonly code: VideoArchiveErrorCode) {
    super(code);
    this.name = "VideoArchiveError";
  }
}

export async function isZipArchive(filePath: string): Promise<boolean> {
  let file;
  try {
    file = await open(filePath, "r");
    const signature = Buffer.alloc(4);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    return (
      bytesRead === signature.length &&
      ZIP_SIGNATURES.some((expected) => signature.equals(expected))
    );
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export function videoArchiveFailureMessage(error: unknown): string {
  const code = error instanceof VideoArchiveError ? error.code : "failed";
  switch (code) {
    case "invalid":
      return "That ZIP archive is invalid or incomplete.";
    case "no-video":
      return "That ZIP archive does not contain a supported video file.";
    case "too-large":
      return "The ZIP video exceeds this bot's 4 GB or safe-expansion limit.";
    case "encrypted":
      return "That ZIP archive is password-protected; password-protected archives are not supported.";
    case "unsupported":
      return "That ZIP archive uses a compression method this bot cannot extract.";
    case "timeout":
      return "Extracting the video from that ZIP archive timed out.";
    case "cancelled":
      return "Video archive extraction cancelled.";
    case "tool-missing":
      return "ZIP extraction is unavailable because Python 3 is missing from this deployment.";
    default:
      return "The video could not be extracted from that ZIP archive.";
  }
}

export async function extractVideoFromZip(
  archivePath: string,
  destinationPath: string,
  options: {
    maxBytes: number;
    signal: AbortSignal;
    onProgress: (downloadedBytes: number, totalBytes: number) => void;
    timeoutMs?: number;
  },
): Promise<{ fileSize: number; fileName: string }> {
  if (options.signal.aborted) {
    throw new VideoArchiveError("cancelled");
  }

  try {
    return await new Promise<{ fileSize: number; fileName: string }>(
      (resolve, reject) => {
        let child;
        try {
          child = spawn(
            process.env["PYTHON_PATH"] || "python3",
            [
              "-I",
              "-B",
              "-c",
              PYTHON_ZIP_EXTRACTOR,
              archivePath,
              destinationPath,
              String(options.maxBytes),
            ],
            {
              env: {
                PATH: process.env["PATH"] ?? "",
                PYTHONDONTWRITEBYTECODE: "1",
              },
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            },
          );
        } catch {
          reject(new VideoArchiveError("tool-missing"));
          return;
        }

        let stderr = "";
        let stdoutRemainder = "";
        let extractedFileName = "";
        let settled = false;
        let timedOut = false;
        const finish = (
          error?: VideoArchiveError,
          result?: { fileSize: number; fileName: string },
        ): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          options.signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else if (result) resolve(result);
          else reject(new VideoArchiveError("failed"));
        };
        const consumeOutput = (chunk: string): void => {
          const lines = (stdoutRemainder + chunk).split(/\r\n|\n|\r/u);
          stdoutRemainder = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("__VIDEO_ARCHIVE_FILENAME__")) {
              extractedFileName = line
                .slice("__VIDEO_ARCHIVE_FILENAME__".length)
                .replace(/[\u0000-\u001f\u007f]/gu, "");
              continue;
            }
            const match = line.match(/__VIDEO_ARCHIVE_PROGRESS__(\d+)\|(\d+)/u);
            if (!match) continue;
            try {
              options.onProgress(Number(match[1]), Number(match[2]));
            } catch {
              // Progress reporting must not interrupt extraction.
            }
          }
        };
        const onAbort = (): void => {
          child.kill("SIGKILL");
        };
        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS);

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", consumeOutput);
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
        });
        options.signal.addEventListener("abort", onAbort, { once: true });
        child.once("error", (error: NodeJS.ErrnoException) => {
          finish(
            new VideoArchiveError(
              error.code === "ENOENT" ? "tool-missing" : "failed",
            ),
          );
        });
        child.once("close", async (code) => {
          if (settled) return;
          if (options.signal.aborted) {
            finish(new VideoArchiveError("cancelled"));
            return;
          }
          if (timedOut) {
            finish(new VideoArchiveError("timeout"));
            return;
          }
          if (code !== 0) {
            const errorCode = stderr.match(
              /__VIDEO_ARCHIVE_ERROR__:(invalid|no-video|too-large|encrypted|unsupported)/u,
            )?.[1] as VideoArchiveErrorCode | undefined;
            finish(new VideoArchiveError(errorCode ?? "failed"));
            return;
          }
          try {
            const result = await stat(destinationPath);
            if (!result.isFile() || result.size === 0) {
              finish(new VideoArchiveError("no-video"));
            } else if (result.size > options.maxBytes) {
              finish(new VideoArchiveError("too-large"));
            } else {
              if (!extractedFileName) {
                finish(new VideoArchiveError("failed"));
              } else {
                finish(undefined, {
                  fileSize: result.size,
                  fileName: extractedFileName,
                });
              }
            }
          } catch {
            finish(new VideoArchiveError("failed"));
          }
        });
      },
    );
  } catch (error) {
    await unlink(destinationPath).catch(() => undefined);
    if (error instanceof VideoArchiveError) throw error;
    if (options.signal.aborted) throw new VideoArchiveError("cancelled");
    throw new VideoArchiveError("failed");
  }
}
