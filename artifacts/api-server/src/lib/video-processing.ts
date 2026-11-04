import { spawn, type ChildProcess } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_INPUT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TELEGRAM_OUTPUT_BYTES = 1_900_000_000;

export type VideoResolution = {
  label: string;
  maxWidth: number;
  maxHeight: number;
  shortSide?: number;
  preserveSourceDimensions?: boolean;
};

export const SAME_RESOLUTION_CHOICE = "same";

export function getSameResolutionResolution(
  sourceWidth: number,
  sourceHeight: number,
): VideoResolution {
  return {
    label: "Same resolution",
    maxWidth: sourceWidth,
    maxHeight: sourceHeight,
    preserveSourceDimensions: true,
  };
}

export const PRESET_RESOLUTIONS: VideoResolution[] = [
  { label: "240p", maxWidth: 7680, maxHeight: 240, shortSide: 240 },
  { label: "360p", maxWidth: 7680, maxHeight: 360, shortSide: 360 },
  { label: "420p", maxWidth: 7680, maxHeight: 420, shortSide: 420 },
  { label: "480p", maxWidth: 7680, maxHeight: 480, shortSide: 480 },
  { label: "720p", maxWidth: 7680, maxHeight: 720, shortSide: 720 },
  { label: "960p", maxWidth: 7680, maxHeight: 960, shortSide: 960 },
  { label: "1080p", maxWidth: 7680, maxHeight: 1080, shortSide: 1080 },
  { label: "1440p", maxWidth: 7680, maxHeight: 1440, shortSide: 1440 },
  { label: "2160p / 4K", maxWidth: 7680, maxHeight: 2160, shortSide: 2160 },
];

export type VideoInfo = {
  width: number;
  height: number;
  durationSeconds: number;
};

export const COMPRESSION_CRF_LEVELS = [18] as const;
export const SAME_RESOLUTION_COMPRESSION_CRF_LEVELS = [18] as const;

const MIN_ETA_PROGRESS_FRACTION = 0.05;
const MIN_ETA_ELAPSED_SECONDS = 60;

export function estimateRemainingSeconds(
  progressFraction: number,
  elapsedSeconds: number,
): number | null {
  if (
    !Number.isFinite(progressFraction) ||
    !Number.isFinite(elapsedSeconds) ||
    progressFraction < MIN_ETA_PROGRESS_FRACTION ||
    progressFraction > 1 ||
    elapsedSeconds < MIN_ETA_ELAPSED_SECONDS
  ) {
    return null;
  }
  return Math.max(0, Math.ceil(elapsedSeconds * ((1 - progressFraction) / progressFraction)));
}

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
      | "output_not_smaller"
      | "cancelled"
      | "processing_failed",
  ) {
    super(message);
    this.name = "VideoProcessingError";
  }
}

export function isRetryableResolutionError(
  error: unknown,
): error is VideoProcessingError {
  return (
    error instanceof VideoProcessingError &&
    (error.code === "output_not_smaller" || error.code === "output_too_large")
  );
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
    return {
      label: `${height}p`,
      maxWidth: 7680,
      maxHeight: height,
      shortSide: height,
    };
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

export async function inspectVideoInfo(
  inputPath: string,
  onProcess: (child: ChildProcess | null) => void = () => undefined,
): Promise<VideoInfo> {
  try {
    return await probeVideo(inputPath, (child) => onProcess(child));
  } finally {
    onProcess(null);
  }
}

export function getOutputDimensions(
  sourceWidth: number,
  sourceHeight: number,
  resolution: VideoResolution,
): { width: number; height: number } {
  const scale =
    resolution.shortSide == null
      ? Math.min(
          1,
          resolution.maxWidth / sourceWidth,
          resolution.maxHeight / sourceHeight,
        )
      : Math.min(
          1,
          resolution.shortSide / Math.min(sourceWidth, sourceHeight),
        );
  return {
    width: Math.max(2, Math.floor((sourceWidth * scale) / 2) * 2),
    height: Math.max(2, Math.floor((sourceHeight * scale) / 2) * 2),
  };
}

export function getAvailablePresetResolutions(
  sourceWidth: number,
  sourceHeight: number,
): VideoResolution[] {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth < 2 ||
    sourceHeight < 2
  ) {
    return [];
  }

  return PRESET_RESOLUTIONS.filter((resolution) => {
    const output = getOutputDimensions(sourceWidth, sourceHeight, resolution);
    return output.width < sourceWidth || output.height < sourceHeight;
  });
}

export function getSmallerPresetResolutions(
  sourceWidth: number,
  sourceHeight: number,
  target: VideoResolution,
): VideoResolution[] {
  const targetDimensions = getOutputDimensions(
    sourceWidth,
    sourceHeight,
    target,
  );
  return getAvailablePresetResolutions(sourceWidth, sourceHeight).filter(
    (resolution) => {
      const output = getOutputDimensions(sourceWidth, sourceHeight, resolution);
      return (
        output.width <= targetDimensions.width &&
        output.height <= targetDimensions.height &&
        (output.width < targetDimensions.width ||
          output.height < targetDimensions.height)
      );
    },
  );
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

  const info = await inspectVideoInfo(inputPath, options.onProcess);
  options.onVideoInfo(info);
  const dimensions = getOutputDimensions(
    info.width,
    info.height,
    options.resolution,
  );
  const scaleFilter = `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const crfLevels: readonly number[] = options.resolution.preserveSourceDimensions
    ? SAME_RESOLUTION_COMPRESSION_CRF_LEVELS
    : COMPRESSION_CRF_LEVELS;
  const audioCodecArgs = options.resolution.preserveSourceDimensions
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", "128k", "-ac", "2"];
  let outputBytes = 0;

  try {
    for (
      let attempt = 0;
      attempt < crfLevels.length;
      attempt += 1
    ) {
      const crf = crfLevels[attempt];
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
          "slow",
          "-crf",
          String(crf),
          "-threads",
          "2",
          "-pix_fmt",
          "yuv420p",
          ...audioCodecArgs,
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
      if (
        outputBytes < input.size &&
        outputBytes <= MAX_TELEGRAM_OUTPUT_BYTES
      ) {
        break;
      }
    }

    if (outputBytes >= input.size) {
      throw new VideoProcessingError(
        "No smaller compressed file was found at this size. Try a lower resolution or custom size.",
        "output_not_smaller",
      );
    }
    if (outputBytes > MAX_TELEGRAM_OUTPUT_BYTES) {
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
