import { spawn, type ChildProcess } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_INPUT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TELEGRAM_OUTPUT_BYTES = 1_900_000_000;

export type VideoResolution = {
  label: string;
  maxWidth: number;
  maxHeight: number;
};

export const PRESET_RESOLUTIONS: VideoResolution[] = [
  { label: "240p", maxWidth: 7680, maxHeight: 240 },
  { label: "360p", maxWidth: 7680, maxHeight: 360 },
  { label: "480p", maxWidth: 7680, maxHeight: 480 },
  { label: "720p", maxWidth: 7680, maxHeight: 720 },
  { label: "1080p", maxWidth: 7680, maxHeight: 1080 },
  { label: "1440p", maxWidth: 7680, maxHeight: 1440 },
  { label: "2160p / 4K", maxWidth: 7680, maxHeight: 2160 },
];

export type VideoInfo = {
  width: number;
  height: number;
  durationSeconds: number;
};

export type CompressionResult = {
  outputPath: string;
  width: number;
  height: number;
  durationSeconds: number;
  outputBytes: number;
};

export type CompressionProgress = {
  attempt: number;
  totalAttempts: number;
  fraction: number;
  videoSeconds: number;
  durationSeconds: number;
};

export class VideoProcessingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_video"
      | "input_too_large"
      | "output_too_large"
      | "cancelled"
      | "processing_failed",
  ) {
    super(message);
    this.name = "VideoProcessingError";
  }
}

type ProcessResult = {
  stdout: string;
};

function runProcess(
  command: string,
  args: string[],
  onProcess: (child: ChildProcess) => void,
  onProgress?: (seconds: number) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    onProcess(child);

    let stdout = "";
    let stderrTail = "";
    let progressBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!onProgress) {
        stdout += chunk;
        return;
      }

      progressBuffer += chunk;
      const lines = progressBuffer.split("\n");
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("out_time_us=")) {
          const microseconds = Number(line.slice("out_time_us=".length));
          if (Number.isFinite(microseconds)) {
            onProgress(microseconds / 1_000_000);
          }
        } else if (line.startsWith("out_time_ms=")) {
          const microseconds = Number(line.slice("out_time_ms=".length));
          if (Number.isFinite(microseconds)) {
            onProgress(microseconds / 1_000_000);
          }
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
    });

    child.once("error", () => {
      reject(
        new VideoProcessingError(
          "The video processing tool could not start.",
          "processing_failed",
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      if (signal === "SIGTERM" || signal === "SIGINT") {
        reject(new VideoProcessingError("Compression was cancelled.", "cancelled"));
        return;
      }

      const errorCode = stderrTail.includes("Invalid data found")
        ? "invalid_video"
        : "processing_failed";
      reject(
        new VideoProcessingError(
          errorCode === "invalid_video"
            ? "Telegram could not read this video file."
            : "The video could not be compressed. Try a different file or resolution.",
          errorCode,
        ),
      );
    });
  });
}

export function parseCustomResolution(input: string): VideoResolution | null {
  const normalized = input.trim().toLowerCase().replaceAll(" ", "");
  const preset = normalized.match(/^(\d{3,4})p$/);
  if (preset) {
    const height = Number(preset[1]);
    if (height < 144 || height > 4320) return null;
    return { label: `${height}p`, maxWidth: 7680, maxHeight: height };
  }

  const dimensions = normalized.match(/^(\d{3,4})[x×](\d{3,4})$/);
  if (!dimensions) return null;

  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  if (
    width < 144 ||
    height < 144 ||
    width > 7680 ||
    height > 7680
  ) {
    return null;
  }
  return {
    label: `${width}×${height}`,
    maxWidth: width,
    maxHeight: height,
  };
}

async function probeVideo(
  inputPath: string,
  onProcess: (child: ChildProcess) => void,
): Promise<VideoInfo> {
  const result = await runProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      inputPath,
    ],
    onProcess,
  );

  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    const durationSeconds = Number(parsed.format?.duration);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 2 ||
      height < 2 ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      throw new Error("Missing video dimensions or duration");
    }
    return { width, height, durationSeconds };
  } catch {
    throw new VideoProcessingError(
      "This file does not contain a readable video stream.",
      "invalid_video",
    );
  }
}

function fitDimensions(
  sourceWidth: number,
  sourceHeight: number,
  resolution: VideoResolution,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    resolution.maxWidth / sourceWidth,
    resolution.maxHeight / sourceHeight,
  );
  return {
    width: Math.max(2, Math.floor((sourceWidth * scale) / 2) * 2),
    height: Math.max(2, Math.floor((sourceHeight * scale) / 2) * 2),
  };
}

export async function compressVideo(options: {
  inputPath: string;
  outputPath: string;
  resolution: VideoResolution;
  onProcess: (child: ChildProcess | null) => void;
  onVideoInfo: (info: VideoInfo) => void;
  onProgress: (progress: CompressionProgress) => void;
}): Promise<CompressionResult> {
  const inputPath = options.inputPath;
  if (!isAbsolute(inputPath)) {
    throw new VideoProcessingError(
      "Telegram did not provide a usable local video file.",
      "invalid_video",
    );
  }

  const input = await stat(inputPath).catch(() => null);
  if (!input?.isFile()) {
    throw new VideoProcessingError(
      "Telegram could not access the uploaded video. Please send it again.",
      "invalid_video",
    );
  }
  if (input.size > MAX_INPUT_BYTES) {
    throw new VideoProcessingError(
      "This video is larger than the 4 GB limit.",
      "input_too_large",
    );
  }

  const info = await probeVideo(inputPath, (child) => options.onProcess(child)).finally(
    () => options.onProcess(null),
  );
  options.onVideoInfo(info);
  const dimensions = fitDimensions(info.width, info.height, options.resolution);
  const scaleFilter = `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const crfLevels = [27, 31, 35, 38];
  let outputBytes = 0;
  let succeeded = false;

  try {
    for (let attempt = 0; attempt < crfLevels.length; attempt += 1) {
      const crf = crfLevels[attempt];
      if (crf == null) continue;
      await unlink(options.outputPath).catch(() => undefined);

      await runProcess(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-i",
          inputPath,
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-vf",
          scaleFilter,
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          String(crf),
          "-threads",
          "2",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ac",
          "2",
          "-movflags",
          "+faststart",
          "-progress",
          "pipe:1",
          "-nostats",
          options.outputPath,
        ],
        (child) => options.onProcess(child),
        (seconds) => {
          const attemptProgress = Math.min(1, seconds / info.durationSeconds);
          options.onProgress({
            attempt: attempt + 1,
            totalAttempts: crfLevels.length,
            fraction: attemptProgress,
            videoSeconds: Math.min(info.durationSeconds, Math.max(0, seconds)),
            durationSeconds: info.durationSeconds,
          });
        },
      );

      outputBytes = (await stat(options.outputPath)).size;
      if (outputBytes <= MAX_TELEGRAM_OUTPUT_BYTES) {
        succeeded = true;
        break;
      }
    }

    if (!succeeded) {
      throw new VideoProcessingError(
        "The compressed video is still too large to send through Telegram. Try a lower resolution.",
        "output_too_large",
      );
    }

    // Telegram may not infer metadata from local file:// uploads; probe the finished MP4.
    const outputInfo = await probeVideo(
      options.outputPath,
      (child) => options.onProcess(child),
    );

    return {
      outputPath: options.outputPath,
      width: outputInfo.width,
      height: outputInfo.height,
      durationSeconds: outputInfo.durationSeconds,
      outputBytes,
    };
  } catch (error) {
    await unlink(options.outputPath).catch(() => undefined);
    if (error instanceof VideoProcessingError) throw error;
    throw new VideoProcessingError(
      "The video could not be compressed. Try a different file or resolution.",
      "processing_failed",
    );
  } finally {
    options.onProcess(null);
  }
}

export const videoLimits = {
  maxInputBytes: MAX_INPUT_BYTES,
  maxTelegramOutputBytes: MAX_TELEGRAM_OUTPUT_BYTES,
};
