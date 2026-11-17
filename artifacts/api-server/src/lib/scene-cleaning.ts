import { spawn, type ChildProcess } from "node:child_process";

export const SCENE_CLEANING_LIMITS = {
  freezeSeconds: 0.6,
  blackSeconds: 0.5,
  maxRemovalFraction: 0.25,
  minimumResultSeconds: 3,
  maxIntervals: 100,
} as const;

export type SceneInterval = {
  startSeconds: number;
  endSeconds: number;
  type: "freeze" | "black";
};

export type SceneRemovalPlan = {
  intervals: Array<{
    startSeconds: number;
    endSeconds: number;
  }>;
  removedSeconds: number;
};

export type SceneRemovalFilters = {
  video: string;
  audio: string;
};

export class SceneCleaningCancelledError extends Error {
  constructor() {
    super("Scene detection was cancelled.");
    this.name = "SceneCleaningCancelledError";
  }
}

const MAX_DETECTION_LOG_BYTES = 4 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 5_000;
const NUMBER_PATTERN = "([+-]?(?:\\d+\\.?\\d*|\\.\\d+))";

function addInterval(
  intervals: SceneInterval[],
  startSeconds: number,
  durationSeconds: number,
  type: SceneInterval["type"],
  videoDurationSeconds: number,
): void {
  const minimumSeconds =
    type === "freeze"
      ? SCENE_CLEANING_LIMITS.freezeSeconds
      : SCENE_CLEANING_LIMITS.blackSeconds;
  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= minimumSeconds
  ) {
    return;
  }

  const start = Math.max(0, startSeconds);
  const end = Math.min(videoDurationSeconds, startSeconds + durationSeconds);
  if (end - start > minimumSeconds)
    intervals.push({ startSeconds: start, endSeconds: end, type });
}

/** Parse only confirmed FFmpeg freeze and blackdetect events. */
export function parseSceneDetectionLog(
  log: string,
  videoDurationSeconds: number,
): SceneInterval[] {
  if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
    return [];
  }

  const intervals: SceneInterval[] = [];
  let freezeStart: number | null = null;
  for (const line of log.split(/\r?\n/u)) {
    const startMatch = line.match(
      new RegExp(
        `lavfi\\.freezedetect\\.freeze_start:\\s*${NUMBER_PATTERN}`,
        "u",
      ),
    );
    if (startMatch) freezeStart = Number(startMatch[1]);

    const durationMatch = line.match(
      new RegExp(
        `lavfi\\.freezedetect\\.freeze_duration:\\s*${NUMBER_PATTERN}`,
        "u",
      ),
    );
    if (durationMatch && freezeStart != null) {
      addInterval(
        intervals,
        freezeStart,
        Number(durationMatch[1]),
        "freeze",
        videoDurationSeconds,
      );
      freezeStart = null;
    }

    const blackMatch = line.match(
      new RegExp(
        `black_start:\\s*${NUMBER_PATTERN}.*?black_end:\\s*${NUMBER_PATTERN}.*?black_duration:\\s*${NUMBER_PATTERN}`,
        "u",
      ),
    );
    if (blackMatch) {
      addInterval(
        intervals,
        Number(blackMatch[1]),
        Number(blackMatch[3]),
        "black",
        videoDurationSeconds,
      );
    }
  }

  // freezedetect reports freeze_start immediately, but a freeze that lasts
  // through EOF has no freeze_duration/freeze_end event. Treat EOF as its end.
  if (freezeStart != null) {
    addInterval(
      intervals,
      freezeStart,
      videoDurationSeconds - freezeStart,
      "freeze",
      videoDurationSeconds,
    );
  }

  return intervals;
}

/** Merge overlaps before applying the removal-fraction and minimum-length guards. */
export function createSceneRemovalPlan(
  candidates: SceneInterval[],
  videoDurationSeconds: number,
): SceneRemovalPlan | null {
  if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
    return null;
  }

  const validIntervals = candidates
    .map((interval) => ({
      startSeconds: Math.max(0, interval.startSeconds),
      endSeconds: Math.min(videoDurationSeconds, interval.endSeconds),
      threshold:
        interval.type === "freeze"
          ? SCENE_CLEANING_LIMITS.freezeSeconds
          : SCENE_CLEANING_LIMITS.blackSeconds,
    }))
    .filter(
      (interval) =>
        Number.isFinite(interval.startSeconds) &&
        Number.isFinite(interval.endSeconds) &&
        interval.endSeconds - interval.startSeconds > interval.threshold,
    )
    .map(({ startSeconds, endSeconds }) => ({ startSeconds, endSeconds }))
    .sort(
      (left, right) =>
        left.startSeconds - right.startSeconds ||
        left.endSeconds - right.endSeconds,
    );

  const merged: SceneRemovalPlan["intervals"] = [];
  for (const interval of validIntervals) {
    const previous = merged.at(-1);
    if (previous && interval.startSeconds <= previous.endSeconds) {
      previous.endSeconds = Math.max(previous.endSeconds, interval.endSeconds);
    } else {
      merged.push({ ...interval });
    }
  }

  if (
    merged.length === 0 ||
    merged.length > SCENE_CLEANING_LIMITS.maxIntervals
  ) {
    return null;
  }

  const removedSeconds = merged.reduce(
    (total, interval) => total + interval.endSeconds - interval.startSeconds,
    0,
  );
  const remainingSeconds = videoDurationSeconds - removedSeconds;
  if (
    removedSeconds >
      videoDurationSeconds * SCENE_CLEANING_LIMITS.maxRemovalFraction ||
    remainingSeconds < SCENE_CLEANING_LIMITS.minimumResultSeconds
  ) {
    return null;
  }

  return { intervals: merged, removedSeconds };
}

function formatSeconds(value: number): string {
  return value.toFixed(6);
}

/** Build FFmpeg timestamp filters so the encode trims matching video and audio. */
export function buildSceneRemovalFilters(
  intervals: SceneRemovalPlan["intervals"],
): SceneRemovalFilters {
  if (intervals.length === 0) {
    throw new RangeError("At least one scene interval is required.");
  }

  const selection = intervals
    .map(
      ({ startSeconds, endSeconds }) =>
        `gte(t,${formatSeconds(startSeconds)})*lt(t,${formatSeconds(endSeconds)})`,
    )
    .join("+");
  const timelineOffset = intervals
    .map(({ startSeconds, endSeconds }) => {
      const duration = endSeconds - startSeconds;
      return `if(gte(T,${formatSeconds(endSeconds)}),${formatSeconds(duration)},0)`;
    })
    .join("+");

  return {
    video: `select='not(${selection})',setpts='PTS-STARTPTS-(${timelineOffset})/TB'`,
    audio: `aselect='not(${selection})',asetpts='PTS-STARTPTS-(${timelineOffset})/TB'`,
  };
}

/** Run both FFmpeg detectors; failures are handled by the caller's original-path fallback. */
export function detectSceneIntervals(options: {
  inputPath: string;
  videoDurationSeconds: number;
  timeoutMs: number;
  onProcess: (child: ChildProcess | null) => void;
  isCancelled?: () => boolean;
}): Promise<SceneInterval[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostdin",
        "-i",
        options.inputPath,
        "-map",
        "0:v:0",
        "-vf",
        "freezedetect=n=-60dB:d=0.6,blackdetect=d=0.5:pix_th=0.05",
        "-an",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    options.onProcess(child);

    let stderr = "";
    let overflowed = false;
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.onProcess(null);

      if (options.isCancelled?.()) {
        reject(new SceneCleaningCancelledError());
      } else if (error) {
        reject(error);
      } else if (timedOut || overflowed) {
        reject(new Error("Scene detection did not complete safely."));
      } else {
        resolve(parseSceneDetectionLog(stderr, options.videoDurationSeconds));
      }
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length + chunk.length > MAX_DETECTION_LOG_BYTES) {
        if (overflowed) return;
        overflowed = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(
          () => child.kill("SIGKILL"),
          FORCE_KILL_GRACE_MS,
        );
        return;
      }
      stderr += chunk;
    });

    timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(
          () => child.kill("SIGKILL"),
          FORCE_KILL_GRACE_MS,
        );
      },
      Math.max(1, Math.ceil(options.timeoutMs)),
    );

    child.once("error", () => {
      finish(new Error("FFmpeg scene detection could not start."));
    });
    child.once("close", (code) => {
      if (code !== 0 && !timedOut && !overflowed) {
        finish(new Error("FFmpeg scene detection failed."));
        return;
      }
      finish();
    });
  });
}
