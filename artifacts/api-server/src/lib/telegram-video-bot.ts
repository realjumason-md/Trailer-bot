import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "./logger";
import {
  downloadRemoteVideo,
  RemoteVideoDownloadError,
} from "./remote-video-download";
import {
  compressVideo,
  parseCustomResolution,
  VideoProcessingError,
  videoLimits,
  type CompressionProgress,
  type VideoInfo,
  type VideoResolution,
} from "./video-processing";

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

class TelegramApiError extends Error {
  constructor(
    readonly apiCode: number,
    method: string,
  ) {
    super(`Telegram API ${method} failed (${apiCode}).`);
  }
}

class TelegramTransportError extends Error {
  constructor(
    readonly method: string,
    readonly reason: string,
  ) {
    super(`Telegram ${method} request failed.`);
  }
}

type TelegramUser = {
  id: number;
  first_name?: string;
  username?: string;
};

type TelegramFile = {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  duration?: number;
  width?: number;
  height?: number;
};

type TelegramChat = {
  id: number;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  video?: TelegramFile;
  document?: TelegramFile;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type PendingVideo = {
  key: string;
  chatId: number;
  fileSize: number;
  fileName: string;
  filePath: string;
  statusMessageId: number;
  expiresAt: number;
  durationSeconds?: number;
  sourceWidth?: number;
  sourceHeight?: number;
};

type PreparingVideo = {
  key: string;
  chatId: number;
  source: "upload" | "url";
  fileSize?: number;
  durationSeconds?: number;
  statusMessageId?: number;
  startedAt: number;
  cancelled: boolean;
  abortController?: AbortController;
};

type ActiveJob = {
  key: string;
  chatId: number;
  cancelled: boolean;
  child: ChildProcess | null;
  resolution: string;
  sourceBytes: number;
  statusText: string;
  attempt: number;
  progressPercent: number;
  etaDeadlineAt: number | null;
  attemptStartedAt: number;
};

const LOCAL_API_PORT = Number(
  process.env["TELEGRAM_LOCAL_API_PORT"] ?? "18081",
);
const LOCAL_API_ROOT = `http://127.0.0.1:${LOCAL_API_PORT}`;
const BOT_DATA_DIR = path.resolve(
  process.env["BOT_DATA_DIR"] ?? path.join(tmpdir(), "telegram-video-bot"),
);
const BOT_API_DATA_DIR = path.join(BOT_DATA_DIR, "api-data");
const BOT_API_TEMP_DIR = path.join(BOT_DATA_DIR, "api-temp");
const JOBS_DIR = path.join(BOT_DATA_DIR, "jobs");
const PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_PREPARING_UPLOADS = 1;

const PRESET_RESOLUTIONS: VideoResolution[] = [
  { label: "480p", maxWidth: 7680, maxHeight: 480 },
  { label: "720p", maxWidth: 7680, maxHeight: 720 },
  { label: "1080p", maxWidth: 7680, maxHeight: 1080 },
  { label: "1440p", maxWidth: 7680, maxHeight: 1440 },
  { label: "2160p / 4K", maxWidth: 7680, maxHeight: 2160 },
];

let botToken = "";
let stopping = false;
let localApiProcess: ChildProcess | null = null;
let activeJob: ActiveJob | null = null;
const pendingVideos = new Map<string, PendingVideo>();
const preparingVideos = new Map<string, PreparingVideo>();

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorName(error: unknown): string {
  if (error instanceof VideoProcessingError) return error.code;
  if (error instanceof TelegramApiError) {
    return `telegram_api_${error.apiCode}`;
  }
  if (error instanceof TelegramTransportError) {
    return `telegram_${error.method}_${error.reason}`;
  }
  if (error instanceof Error) return error.name;
  return "unknown_error";
}

function makeSessionKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function localBotApiUrl(method: string): string {
  return `${LOCAL_API_ROOT}/bot${botToken}/${method}`;
}

async function telegramCall<T>(
  method: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 45_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(localBotApiUrl(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TelegramTransportError(
      method,
      error instanceof Error ? error.name : "unknown_error",
    );
  }

  const data = (await response
    .json()
    .catch(() => null)) as TelegramApiResponse<T> | null;
  if (!response.ok || !data?.ok || data.result === undefined) {
    const code = data?.error_code ?? response.status;
    throw new TelegramApiError(code, method);
  }
  return data.result;
}

async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<TelegramMessage> {
  return telegramCall<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    disable_web_page_preview: true,
  });
}

async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  await telegramCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(
  callbackId: string,
  text?: string,
): Promise<void> {
  await telegramCall("answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  });
}

function resolutionKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "480p", callback_data: "resolution:480p" },
        { text: "720p", callback_data: "resolution:720p" },
        { text: "1080p", callback_data: "resolution:1080p" },
      ],
      [
        { text: "1440p", callback_data: "resolution:1440p" },
        { text: "2160p / 4K", callback_data: "resolution:2160p" },
      ],
      [
        { text: "Custom size", callback_data: "resolution:custom" },
        { text: "Cancel", callback_data: "resolution:cancel" },
      ],
    ],
  };
}

function findResolution(value: string): VideoResolution | null {
  return (
    PRESET_RESOLUTIONS.find((resolution) => resolution.label === value) ??
    parseCustomResolution(value)
  );
}

async function prepareVideo(
  message: TelegramMessage,
  file: TelegramFile,
): Promise<void> {
  const userId = message.from?.id;
  if (userId == null) return;
  const key = makeSessionKey(message.chat.id, userId);

  if (activeJob) {
    await sendMessage(
      message.chat.id,
      "A video is being compressed right now. Please try again when it is finished.",
    );
    return;
  }
  if (pendingVideos.has(key)) {
    await sendMessage(
      message.chat.id,
      "You already have a video waiting for a resolution. Choose one below or send /cancel first.",
    );
    return;
  }
  if (preparingVideos.size >= MAX_PREPARING_UPLOADS) {
    await sendMessage(
      message.chat.id,
      "Another upload is being prepared. Please wait for it to finish before sending another video.",
    );
    return;
  }

  if (file.file_size != null && file.file_size > videoLimits.maxInputBytes) {
    await sendMessage(message.chat.id, "This bot accepts videos up to 4 GB.");
    return;
  }

  const preparation: PreparingVideo = {
    key,
    chatId: message.chat.id,
    source: "upload",
    fileSize: file.file_size,
    durationSeconds: file.duration,
    startedAt: Date.now(),
    cancelled: false,
  };
  preparingVideos.set(key, preparation);
  try {
    const reportedSize =
      file.file_size == null ? "" : ` (${formatBytes(file.file_size)})`;
    const reportedDuration =
      file.duration != null ? ` · ${formatDuration(file.duration)}` : "";
    const status = await sendMessage(
      message.chat.id,
      `Video received${reportedSize}${reportedDuration}. Preparing the upload. Compression starts after you choose a resolution; I’ll estimate the time as it encodes.`,
    );
    preparation.statusMessageId = status.message_id;

    let fetched: { file_path?: string };
    try {
      fetched = await telegramCall<{ file_path?: string }>(
        "getFile",
        { file_id: file.file_id },
        6 * 60 * 60 * 1000,
      );
    } catch (error) {
      logger.warn(
        { code: errorName(error) },
        "Could not prepare an uploaded video",
      );
      await editMessage(
        message.chat.id,
        status.message_id,
        "I couldn't prepare that video. Please send it again, or try a smaller file.",
      ).catch(() => undefined);
      return;
    }

    if (preparation.cancelled) {
      if (fetched.file_path) await removeOwnedInput(fetched.file_path);
      await editMessage(
        message.chat.id,
        status.message_id,
        "Upload preparation cancelled.",
      ).catch(() => undefined);
      return;
    }

    if (!fetched.file_path || !path.isAbsolute(fetched.file_path)) {
      await editMessage(
        message.chat.id,
        status.message_id,
        "Telegram did not return a local video file. The local Bot API server must be running for large uploads.",
      );
      return;
    }
    if (
      !path
        .resolve(fetched.file_path)
        .startsWith(`${path.resolve(BOT_API_DATA_DIR)}${path.sep}`)
    ) {
      await editMessage(
        message.chat.id,
        status.message_id,
        "The local Bot API server returned a file outside its configured storage. Please check its file storage settings.",
      );
      return;
    }

    const localFile = await stat(fetched.file_path).catch(() => null);
    if (!localFile?.isFile()) {
      await editMessage(
        message.chat.id,
        status.message_id,
        "Telegram could not access the uploaded video. Please send it again.",
      );
      return;
    }
    if (localFile.size > videoLimits.maxInputBytes) {
      await editMessage(
        message.chat.id,
        status.message_id,
        "This bot accepts videos up to 4 GB.",
      );
      return;
    }
    preparation.fileSize = localFile.size;

    await editMessage(
      message.chat.id,
      status.message_id,
      `Video ready (${formatBytes(localFile.size)}${file.duration != null ? ` · ${formatDuration(file.duration)}` : ""}). Choose an output resolution. I’ll show an estimated time once encoding begins.`,
      resolutionKeyboard(),
    );
    pendingVideos.set(key, {
      key,
      chatId: message.chat.id,
      fileSize: localFile.size,
      fileName: path.basename(file.file_name ?? "video"),
      filePath: fetched.file_path,
      statusMessageId: status.message_id,
      expiresAt: Date.now() + PENDING_TTL_MS,
      durationSeconds: file.duration,
      sourceWidth: file.width,
      sourceHeight: file.height,
    });
  } finally {
    preparingVideos.delete(key);
  }
}

async function prepareVideoFromUrl(
  message: TelegramMessage,
  url: string,
): Promise<void> {
  const userId = message.from?.id;
  if (userId == null) return;
  const key = makeSessionKey(message.chat.id, userId);

  if (activeJob) {
    await sendMessage(
      message.chat.id,
      "A video is being compressed right now. Please try again when it is finished.",
    );
    return;
  }
  if (pendingVideos.has(key)) {
    await sendMessage(
      message.chat.id,
      "You already have a video waiting for a resolution. Choose one below or send /cancel first.",
    );
    return;
  }
  if (preparingVideos.size >= MAX_PREPARING_UPLOADS) {
    await sendMessage(
      message.chat.id,
      "Another video is being prepared. Please wait for it to finish before sending another link.",
    );
    return;
  }

  const inputPath = path.join(JOBS_DIR, `${randomUUID()}.download`);
  const abortController = new AbortController();
  const preparation: PreparingVideo = {
    key,
    chatId: message.chat.id,
    source: "url",
    startedAt: Date.now(),
    cancelled: false,
    abortController,
  };
  preparingVideos.set(key, preparation);
  let fileTransferredToPending = false;

  try {
    const status = await sendMessage(
      message.chat.id,
      "Downloading the direct video link (maximum 4 GB). You’ll choose an output resolution when the file is ready.",
    );
    preparation.statusMessageId = status.message_id;

    let lastProgressAt = Date.now();
    let lastProgressPercent = -10;
    const downloadedBytes = await downloadRemoteVideo(url, inputPath, {
      maxBytes: videoLimits.maxInputBytes,
      signal: abortController.signal,
      onProgress: (progress) => {
        preparation.fileSize = progress.downloadedBytes;
        const now = Date.now();
        const percent =
          progress.totalBytes && progress.totalBytes > 0
            ? Math.floor((progress.downloadedBytes / progress.totalBytes) * 100)
            : null;
        if (
          now - lastProgressAt >= 15_000 ||
          (percent != null && percent >= lastProgressPercent + 10)
        ) {
          lastProgressAt = now;
          if (percent != null) lastProgressPercent = percent;
          const progressLabel =
            percent == null
              ? formatBytes(progress.downloadedBytes)
              : `${percent}%`;
          void editMessage(
            message.chat.id,
            status.message_id,
            `Downloading video: ${progressLabel} (${formatBytes(progress.downloadedBytes)}). Send /cancel to stop.`,
          ).catch(() => undefined);
        }
      },
    });

    if (preparation.cancelled) {
      await unlink(inputPath).catch(() => undefined);
      await editMessage(
        message.chat.id,
        status.message_id,
        "Video download cancelled.",
      ).catch(() => undefined);
      return;
    }
    const localFile = await stat(inputPath).catch(() => null);
    if (!localFile?.isFile() || localFile.size !== downloadedBytes) {
      throw new RemoteVideoDownloadError(
        "The video download did not finish correctly. Please try the link again.",
      );
    }
    if (localFile.size > videoLimits.maxInputBytes) {
      throw new RemoteVideoDownloadError("This bot accepts videos up to 4 GB.");
    }

    preparation.fileSize = localFile.size;
    const parsedUrl = new URL(url);
    const fileName = path.basename(parsedUrl.pathname) || "linked-video";
    await editMessage(
      message.chat.id,
      status.message_id,
      `Video ready (original size: ${formatBytes(localFile.size)}). Choose an output resolution. I’ll show the encoding countdown once compression begins.`,
      resolutionKeyboard(),
    );
    pendingVideos.set(key, {
      key,
      chatId: message.chat.id,
      fileSize: localFile.size,
      fileName,
      filePath: inputPath,
      statusMessageId: status.message_id,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    fileTransferredToPending = true;
  } catch (error) {
    const cancelled = preparation.cancelled || abortController.signal.aborted;
    const userMessage = cancelled
      ? "Video download cancelled."
      : error instanceof RemoteVideoDownloadError
        ? error.message
        : "I couldn’t download that video link. Check it and try again.";
    if (preparation.statusMessageId != null) {
      await editMessage(
        message.chat.id,
        preparation.statusMessageId,
        userMessage,
      ).catch(() => undefined);
    } else {
      await sendMessage(message.chat.id, userMessage).catch(() => undefined);
    }
    if (!cancelled) {
      logger.warn(
        { code: error instanceof Error ? error.name : "unknown_error" },
        "Could not download a linked video",
      );
    }
  } finally {
    preparingVideos.delete(key);
    if (!fileTransferredToPending) {
      await unlink(inputPath).catch(() => undefined);
    }
  }
}

function formatBytes(bytes: number): string {
  const gigabytes = bytes / 1_000_000_000;
  if (gigabytes >= 1) return `${gigabytes.toFixed(2)} GB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainder = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${remainder}s`;
}

function formatCountdown(seconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainder = totalSeconds % 60;
  return [hours, minutes, remainder]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function describeCompressionStatus(job: ActiveJob): string {
  const percent = `${job.progressPercent}%`;
  const eta =
    job.etaDeadlineAt == null
      ? "Measuring encoding speed; the countdown will appear shortly."
      : `Estimated time remaining ${formatCountdown((job.etaDeadlineAt - Date.now()) / 1_000)}.`;
  return `Original size ${formatBytes(job.sourceBytes)} · compressing to ${job.resolution} · pass ${job.attempt}/4 · ${percent}. ${eta} An extra pass may be needed to meet Telegram’s size limit.`;
}

async function removeOwnedInput(filePath: string): Promise<void> {
  const resolvedFile = path.resolve(filePath);
  const ownedRoots = [BOT_API_DATA_DIR, JOBS_DIR].map((root) =>
    path.resolve(root),
  );
  if (
    ownedRoots.some((root) => resolvedFile.startsWith(`${root}${path.sep}`))
  ) {
    await unlink(resolvedFile).catch(() => undefined);
  }
}

function clearExpiredPendingVideos(): void {
  for (const [key, pending] of pendingVideos) {
    if (pending.expiresAt < Date.now()) {
      pendingVideos.delete(key);
      void removeOwnedInput(pending.filePath);
      void editMessage(
        pending.chatId,
        pending.statusMessageId,
        "This video selection expired. Send the video again when you are ready.",
      ).catch(() => undefined);
    }
  }
}

function isVideoFile(file: TelegramFile | undefined): file is TelegramFile {
  if (!file) return false;
  if (file.mime_type?.startsWith("video/")) return true;
  return /\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|3gp)$/i.test(
    file.file_name ?? "",
  );
}

function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  const text = message.text?.trim();
  const userId = message.from?.id;

  if (text?.startsWith("/start") || text?.startsWith("/help")) {
    await sendMessage(
      message.chat.id,
      [
        "Send me a video up to 4 GB, or paste a direct public link to a video file.",
        "Web pages and streaming-platform links are not direct downloads.",
        "Choose a resolution from the buttons, or enter a custom size such as 720p or 1280x720.",
        "",
        "Use /status to check a job and /cancel to stop or clear it.",
        "The original file size stays visible while compressing; the estimated countdown updates using this video’s actual encoding speed.",
        "The compressed file is returned here and must fit Telegram's 1.9 GB delivery limit.",
      ].join("\n"),
    );
    return;
  }

  if (text?.startsWith("/status")) {
    const key = userId == null ? "" : makeSessionKey(message.chat.id, userId);
    if (activeJob?.key === key) {
      await sendMessage(message.chat.id, activeJob.statusText);
    } else if (key && pendingVideos.has(key)) {
      const pending = pendingVideos.get(key);
      const duration =
        pending?.durationSeconds != null
          ? ` (${formatDuration(pending.durationSeconds)})`
          : "";
      await sendMessage(
        message.chat.id,
        `Your video${duration} is ready. Choose a resolution using the buttons above.`,
      );
    } else if (key && preparingVideos.has(key)) {
      const preparation = preparingVideos.get(key);
      const details = [
        preparation?.fileSize != null
          ? preparation.source === "url"
            ? `${formatBytes(preparation.fileSize)} downloaded`
            : formatBytes(preparation.fileSize)
          : undefined,
        preparation?.durationSeconds != null
          ? formatDuration(preparation.durationSeconds)
          : undefined,
      ].filter((part): part is string => Boolean(part));
      const elapsed = preparation
        ? formatDuration((Date.now() - preparation.startedAt) / 1_000)
        : "";
      await sendMessage(
        message.chat.id,
        `Your ${preparation?.source === "url" ? "linked " : ""}video${details.length ? ` (${details.join(" · ")})` : ""} is still being prepared${elapsed ? `; this has taken ${elapsed}` : ""}. Compression hasn’t started yet. You’ll get a resolution choice when the file is ready.`,
      );
    } else {
      await sendMessage(message.chat.id, "No video is waiting or processing.");
    }
    return;
  }

  if (text?.startsWith("/cancel")) {
    const key = userId == null ? "" : makeSessionKey(message.chat.id, userId);
    const pending = key ? pendingVideos.get(key) : undefined;
    if (pending) {
      pendingVideos.delete(key);
      await removeOwnedInput(pending.filePath);
      await editMessage(
        pending.chatId,
        pending.statusMessageId,
        "Video cancelled. Send another video whenever you are ready.",
      ).catch(() => undefined);
      await sendMessage(message.chat.id, "Your waiting video was cancelled.");
      return;
    }
    const preparation = key ? preparingVideos.get(key) : undefined;
    if (preparation) {
      preparation.cancelled = true;
      preparation.abortController?.abort();
      if (preparation.statusMessageId != null) {
        await editMessage(
          preparation.chatId,
          preparation.statusMessageId,
          preparation.source === "url"
            ? "Cancelling the video download..."
            : "Cancelling upload preparation. Telegram may take a little while to finish the transfer.",
        ).catch(() => undefined);
      }
      await sendMessage(
        message.chat.id,
        preparation.source === "url"
          ? "The video download is being cancelled."
          : "Upload preparation will be cancelled when Telegram finishes the transfer.",
      );
      return;
    }
    if (key && activeJob?.key === key) {
      activeJob.cancelled = true;
      activeJob.child?.kill("SIGTERM");
      await sendMessage(message.chat.id, "Stopping compression...");
      return;
    }
    await sendMessage(
      message.chat.id,
      "You do not have a waiting video to cancel.",
    );
    return;
  }

  if (userId != null && text) {
    const key = makeSessionKey(message.chat.id, userId);
    const pending = pendingVideos.get(key);
    if (pending && !text.startsWith("/")) {
      const resolution = parseCustomResolution(text);
      if (!resolution) {
        await sendMessage(
          message.chat.id,
          "Enter a size like 720p or 1280x720. Each dimension must be between 144 and 7680 pixels.",
        );
        return;
      }
      await beginCompression(pending, resolution);
      return;
    }
  }

  if (text && isHttpUrl(text)) {
    void prepareVideoFromUrl(message, text).catch((error: unknown) => {
      logger.warn(
        { code: errorName(error), updateType: "video_url" },
        "Could not prepare a linked video",
      );
      void sendMessage(
        message.chat.id,
        "I couldn’t prepare that video link. Paste a direct public download link and try again.",
      ).catch(() => undefined);
    });
    return;
  }

  const file = message.video
    ? message.video
    : isVideoFile(message.document)
      ? message.document
      : undefined;
  if (file) {
    void prepareVideo(message, file).catch((error: unknown) => {
      logger.warn(
        { code: errorName(error), updateType: "video" },
        "Could not handle uploaded video",
      );
      void sendMessage(
        message.chat.id,
        "I couldn't prepare that video. Please send it again, or try a smaller file.",
      ).catch(() => undefined);
    });
    return;
  }

  if (text && !text.startsWith("/")) {
    await sendMessage(
      message.chat.id,
      "Send a video file to compress, or use /help for instructions.",
    );
  }
}

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  const message = callback.message;
  if (!message || !callback.data) {
    await answerCallback(callback.id);
    return;
  }
  const key = makeSessionKey(message.chat.id, callback.from.id);
  const pending = pendingVideos.get(key);
  if (!pending || pending.expiresAt < Date.now()) {
    if (pending) {
      pendingVideos.delete(key);
      await removeOwnedInput(pending.filePath);
    }
    await answerCallback(callback.id, "This video selection expired.");
    return;
  }

  const choice = callback.data.replace("resolution:", "");
  if (choice === "cancel") {
    pendingVideos.delete(key);
    await answerCallback(callback.id, "Video cancelled.");
    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      "Video cancelled. Send another video whenever you are ready.",
    );
    await removeOwnedInput(pending.filePath);
    return;
  }
  if (choice === "custom") {
    await answerCallback(callback.id);
    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      "Send a target size such as 720p or 1280x720. The video will keep its aspect ratio and will not be enlarged.",
      {
        inline_keyboard: [
          [{ text: "Cancel", callback_data: "resolution:cancel" }],
        ],
      },
    );
    return;
  }

  const resolution = findResolution(choice);
  if (!resolution) {
    await answerCallback(callback.id, "That resolution is not available.");
    return;
  }

  await answerCallback(
    callback.id,
    `Starting ${resolution.label} compression.`,
  );
  await beginCompression(pending, resolution);
}

async function beginCompression(
  pending: PendingVideo,
  resolution: VideoResolution,
): Promise<void> {
  if (activeJob) {
    await sendMessage(
      pending.chatId,
      `Another video is currently processing. This ${formatBytes(pending.fileSize)} video is still waiting; try again when the current job finishes.`,
    );
    return;
  }

  const job: ActiveJob = {
    key: pending.key,
    chatId: pending.chatId,
    cancelled: false,
    child: null,
    resolution: resolution.label,
    sourceBytes: pending.fileSize,
    statusText: `Starting ${resolution.label} compression. Original size: ${formatBytes(pending.fileSize)}. Measuring encoding speed for the countdown.`,
    attempt: 1,
    progressPercent: 0,
    etaDeadlineAt: null,
    attemptStartedAt: Date.now(),
  };
  activeJob = job;
  pendingVideos.delete(pending.key);
  await editMessage(
    pending.chatId,
    pending.statusMessageId,
    job.statusText,
  ).catch(() => undefined);

  void runCompressionJob(job, pending, resolution);
}

async function runCompressionJob(
  job: ActiveJob,
  pending: PendingVideo,
  resolution: VideoResolution,
): Promise<void> {
  let inputPath: string | null = null;
  const outputPath = path.join(JOBS_DIR, `${randomUUID()}.mp4`);
  try {
    inputPath = pending.filePath;
    const sourceStat = await stat(inputPath).catch(() => null);
    if (!sourceStat?.isFile()) {
      throw new VideoProcessingError(
        "Telegram could not access the uploaded video. Please send it again.",
        "invalid_video",
      );
    }
    if (sourceStat.size > videoLimits.maxInputBytes) {
      throw new VideoProcessingError(
        "This video is larger than the 4 GB limit.",
        "input_too_large",
      );
    }

    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      job.statusText,
    ).catch(() => undefined);

    let lastUpdatePercent = -10;
    let lastMessageAt = Date.now();
    const result = await compressVideo({
      inputPath,
      outputPath,
      resolution,
      onVideoInfo: (info: VideoInfo) => {
        job.attempt = 1;
        job.attemptStartedAt = Date.now();
        job.progressPercent = 0;
        job.etaDeadlineAt = null;
        job.statusText = `Original size ${formatBytes(job.sourceBytes)} · compressing ${resolution.label} for a ${formatDuration(info.durationSeconds)} video. Measuring encoding speed; the countdown will appear shortly.`;
        void editMessage(
          pending.chatId,
          pending.statusMessageId,
          job.statusText,
        ).catch(() => undefined);
      },
      onProcess: (child) => {
        job.child = child;
        if (job.cancelled && child) child.kill("SIGTERM");
      },
      onProgress: (progress: CompressionProgress) => {
        if (job.cancelled) return;
        const now = Date.now();
        if (progress.attempt !== job.attempt) {
          job.attempt = progress.attempt;
          job.attemptStartedAt = now;
          job.progressPercent = 0;
          job.etaDeadlineAt = null;
          lastUpdatePercent = -10;
        }
        job.progressPercent = Math.min(99, Math.floor(progress.fraction * 100));
        const attemptElapsedSeconds = (now - job.attemptStartedAt) / 1_000;
        if (progress.fraction >= 0.005 && attemptElapsedSeconds >= 10) {
          const remainingSeconds = Math.max(
            0,
            attemptElapsedSeconds *
              ((1 - progress.fraction) / progress.fraction),
          );
          job.etaDeadlineAt = now + remainingSeconds * 1_000;
        }
        job.statusText = describeCompressionStatus(job);
        if (
          job.progressPercent >= lastUpdatePercent + 10 ||
          now - lastMessageAt >= 15_000
        ) {
          lastUpdatePercent = job.progressPercent;
          lastMessageAt = now;
          void editMessage(
            pending.chatId,
            pending.statusMessageId,
            job.statusText,
          ).catch(() => undefined);
        }
      },
    });

    if (job.cancelled) {
      throw new VideoProcessingError("Compression was cancelled.", "cancelled");
    }

    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      `Compression finished (${result.width}×${result.height}). Original: ${formatBytes(pending.fileSize)} · compressed: ${formatBytes(result.outputBytes)}. Sending it to Telegram...`,
    ).catch(() => undefined);

    await telegramCall(
      "sendVideo",
      {
        chat_id: pending.chatId,
        video: pathToFileURL(result.outputPath).href,
        caption: `Compressed to ${result.width}×${result.height} · original ${formatBytes(pending.fileSize)} → ${formatBytes(result.outputBytes)}`,
        supports_streaming: true,
      },
      6 * 60 * 60 * 1000,
    );

    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      `Done. The compressed video has been sent. Original: ${formatBytes(pending.fileSize)} · outcome: ${formatBytes(result.outputBytes)}.`,
    ).catch(() => undefined);
  } catch (error) {
    const userMessage =
      error instanceof VideoProcessingError
        ? error.message
        : "The video could not be processed. Please try again.";
    logger.warn(
      { code: errorName(error), chatId: job.chatId },
      "Video compression job failed",
    );
    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      job.cancelled ? "Compression cancelled." : userMessage,
    ).catch(() => undefined);
  } finally {
    await unlink(outputPath).catch(() => undefined);
    if (inputPath) await removeOwnedInput(inputPath);
    if (activeJob === job) activeJob = null;
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}

function startLocalBotApi(): ChildProcess {
  const child = spawn(
    "telegram-bot-api",
    [
      "--local",
      `--http-port=${LOCAL_API_PORT}`,
      "--http-ip-address=127.0.0.1",
      `--dir=${BOT_API_DATA_DIR}`,
      `--temp-dir=${BOT_API_TEMP_DIR}`,
      "--verbosity=1",
    ],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? tmpdir(),
        TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
        TELEGRAM_API_ID: process.env["TELEGRAM_API_ID"] ?? "",
        TELEGRAM_API_HASH: process.env["TELEGRAM_API_HASH"] ?? "",
        NIX_SSL_CERT_FILE:
          process.env["NIX_SSL_CERT_FILE"] ??
          process.env["SSL_CERT_FILE"] ??
          "/etc/ssl/certs/ca-certificates.crt",
        SSL_CERT_FILE:
          process.env["SSL_CERT_FILE"] ??
          process.env["NIX_SSL_CERT_FILE"] ??
          "/etc/ssl/certs/ca-certificates.crt",
        SSL_CERT_DIR: process.env["SSL_CERT_DIR"] ?? "/etc/ssl/certs",
      },
      stdio: "ignore",
    },
  );

  child.once("error", () => {
    logger.error("Could not start Telegram's local Bot API server.");
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      logger.error(
        { code, signal },
        "Telegram's local Bot API server stopped unexpectedly.",
      );
    }
  });
  return child;
}

async function waitForLocalApi(
  child: ChildProcess,
  timeoutMs = 90_000,
): Promise<TelegramUser> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        "Telegram's local Bot API server stopped during startup.",
      );
    }
    try {
      return await telegramCall<TelegramUser>("getMe", {}, 10_000);
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        error.apiCode >= 400 &&
        error.apiCode < 500 &&
        error.apiCode !== 429
      ) {
        throw error;
      }
      lastError = error;
      await wait(1_500);
    }
  }
  throw new Error(
    `Telegram's local Bot API server did not become ready (${errorName(lastError)}).`,
  );
}

async function pollUpdates(): Promise<void> {
  let offset = 0;
  while (!stopping) {
    try {
      const updates = await telegramCall<TelegramUpdate[]>(
        "getUpdates",
        {
          offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        },
        40_000,
      );

      clearExpiredPendingVideos();
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const updateType = update.message?.video
          ? "video"
          : update.message?.document
            ? "document"
            : update.message?.text
              ? "text"
              : update.callback_query
                ? "callback"
                : "other";
        logger.info(
          { updateId: update.update_id, updateType },
          "Telegram update received",
        );
        try {
          await handleUpdate(update);
        } catch (error) {
          logger.warn(
            {
              code: errorName(error),
              updateId: update.update_id,
              updateType,
            },
            "Could not handle Telegram update",
          );
          if (update.message) {
            await sendMessage(
              update.message.chat.id,
              "I couldn't handle that request. Please try again.",
            ).catch(() => undefined);
          } else if (update.callback_query) {
            await answerCallback(
              update.callback_query.id,
              "That action failed. Please try again.",
            ).catch(() => undefined);
          }
        }
      }
    } catch (error) {
      if (stopping) return;
      logger.warn(
        { code: errorName(error) },
        "Telegram update polling failed; retrying",
      );
      await wait(2_000);
    }
  }
}

export async function startTelegramVideoBot(): Promise<() => void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const apiId = process.env["TELEGRAM_API_ID"];
  const apiHash = process.env["TELEGRAM_API_HASH"];
  if (!token || !apiId || !apiHash) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN, TELEGRAM_API_ID, and TELEGRAM_API_HASH are required.",
    );
  }
  if (!Number.isInteger(LOCAL_API_PORT) || LOCAL_API_PORT < 1024) {
    throw new Error("TELEGRAM_LOCAL_API_PORT must be a valid port number.");
  }

  botToken = token;
  stopping = false;
  await Promise.all([
    mkdir(BOT_API_DATA_DIR, { recursive: true }),
    mkdir(BOT_API_TEMP_DIR, { recursive: true }),
    mkdir(JOBS_DIR, { recursive: true }),
  ]);

  try {
    localApiProcess = startLocalBotApi();
    const bot = await waitForLocalApi(localApiProcess);
    const webhook = await telegramCall<{ url: string }>("getWebhookInfo");
    if (webhook.url) {
      throw new Error(
        "This Telegram bot already has a webhook configured. Remove it before using the local polling bot.",
      );
    }
    await telegramCall("setMyCommands", {
      commands: [
        { command: "start", description: "Start the video compressor" },
        { command: "help", description: "Show usage instructions" },
        { command: "status", description: "Check your current job" },
        { command: "cancel", description: "Cancel a waiting or active job" },
      ],
    });
    await telegramCall("setMyDescription", {
      description:
        "Compress videos to the resolution you choose. Send a video, select a preset or custom size, and receive the compressed file here.",
    });
    await telegramCall("setMyShortDescription", {
      short_description: "Compress videos to your chosen resolution.",
    });

    logger.info(
      {
        username: bot.username ?? "configured bot",
        localApiPort: LOCAL_API_PORT,
      },
      "Telegram video compressor is ready",
    );
    void pollUpdates();

    return stopTelegramVideoBot;
  } catch (error) {
    stopTelegramVideoBot();
    throw error;
  }
}

export function stopTelegramVideoBot(): void {
  stopping = true;
  activeJob?.child?.kill("SIGTERM");
  localApiProcess?.kill("SIGTERM");
  localApiProcess = null;
  botToken = "";
}
