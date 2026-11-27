    const fallback = await sendMessage(
        message.chat.id,
        `Your video is ready · original ${sourceInfo.width}×${sourceInfo.height}. Choose Original ${sourceInfo.width}×${sourceInfo.height} to compress without downscaling or one of the lower sizes below. If no button appears, send a smaller custom size such as 360p or 640x360.`,
        resolutionKeyboard(sourceInfo.width, sourceInfo.height),
      ).catch(() => undefined);
      if (fallback) pending.statusMessageId = fallback.message_id;
    });
    if (preparation.cancelled) {
      pendingVideos.delete(id);
      await removeOwnedInput(fetched.file_path);
      await editMessage(
        message.chat.id,
        pending.statusMessageId,
        "Upload preparation cancelled.",
      ).catch(() => undefined);
    }
  } finally {
    preparingVideos.delete(id);
  }
}

function zipArchiveFileName(urlValue: string): string {
  try {
    const fileName = path.basename(new URL(urlValue).pathname);
    const safeName = fileName.replace(/[^A-Za-z0-9._-]/gu, "_").slice(-100);
    if (safeName && safeName.toLowerCase().endsWith(".zip")) return safeName;
  } catch {
    // Use a safe fallback for links whose path does not expose a ZIP name.
  }
  return "video-archive.zip";
}

async function prepareVideoFromUrl(
  message: TelegramMessage,
  url: string,
  source: "url" | "tiktok" = "url",
): Promise<void> {
  const zipUrl = source === "url" && isZipArchiveUrl(url);
  const userId = message.from?.id;
  if (userId == null) return;
  const key = makeSessionKey(message.chat.id, userId);

  if (!canPrepareAnotherVideo(message.chat.id)) return;
  if (!canSubmitVideo(message.chat.id, userId)) return;

  const id = randomUUID();
  const inputPath = path.join(JOBS_DIR, `${randomUUID()}.download`);
  let cleanupPath = inputPath;
  const abortController = new AbortController();
  const preparation: PreparingVideo = {
    id,
    key,
    chatId: message.chat.id,
    source,
    filePath: inputPath,
    startedAt: Date.now(),
    cancelled: false,
    abortController,
  };
  preparingVideos.set(id, preparation);
  let fileTransferredToPending = false;
  let archiveDetected = false;
  const siteName = source === "tiktok" ? "TikTok" : getVideoSiteName(url);

  try {
    const status = await sendMessage(
      message.chat.id,
      source === "tiktok"
        ? "Fetching this public TikTok post without signing in. Choose an output resolution when ready; oversized originals are split without re-encoding."
        : zipUrl
          ? `Downloading this public ZIP archive (maximum ${formatBytes(videoLimits.maxTelegramOutputBytes)}). It will be sent unchanged so you can extract the video.`
          : `Preparing this public ${siteName} video link (maximum ${videoLimits.maxInputSizeLabel}). Choose an output resolution when ready; oversized originals are split without re-encoding.`,
    );
    preparation.statusMessageId = status.message_id;

    let lastProgressAt = Date.now();
    let lastProgressPercent = -10;
    let progressActivity =
      source === "tiktok"
        ? "Fetching TikTok video"
        : zipUrl
          ? "Downloading ZIP archive"
          : `Downloading ${siteName} video`;
    const reportDownloadProgress = (
      downloadedBytes: number,
      totalBytes?: number,
    ): void => {
      preparation.fileSize = downloadedBytes;
      const now = Date.now();
      const percent =
        totalBytes && totalBytes > 0
          ? Math.floor((downloadedBytes / totalBytes) * 100)
          : null;
      if (
        now - lastProgressAt >= 15_000 ||
        (percent != null && percent >= lastProgressPercent + 10)
      ) {
        lastProgressAt = now;
        if (percent != null) lastProgressPercent = percent;
        const progressLabel =
          percent == null ? formatBytes(downloadedBytes) : `${percent}%`;
        void editMessage(
          message.chat.id,
          status.message_id,
          `${progressActivity}: ${progressLabel} (${formatBytes(downloadedBytes)}). Tap “Cancel waiting” to stop.`,
        ).catch(() => undefined);
      }
    };
    const downloadWithYtDlp = (): Promise<number> =>
      downloadPublicSiteVideo(url, inputPath, {
        maxBytes: videoLimits.maxInputBytes,
        signal: abortController.signal,
        onProgress: (bytes, totalBytes) =>
          reportDownloadProgress(bytes, totalBytes),
      });
    let downloadedBytes: number;
    if (source === "tiktok") {
      downloadedBytes = await downloadTikTokVideo(url, inputPath, {
        maxBytes: videoLimits.maxInputBytes,
        signal: abortController.signal,
        onProgress: (bytes) => reportDownloadProgress(bytes),
      });
    } else if (zipUrl) {
      try {
        downloadedBytes = await downloadRemoteVideo(url, inputPath, {
          maxBytes: videoLimits.maxTelegramOutputBytes,
          signal: abortController.signal,
          onProgress: (progress) =>
            reportDownloadProgress(
              progress.downloadedBytes,
              progress.totalBytes,
            ),
        });
      } catch (error) {
        if (
          error instanceof RemoteVideoDownloadError &&
          error.code === "input_too_large"
        ) {
          throw new RemoteVideoDownloadError(
            `This ZIP archive exceeds Telegram’s ${formatBytes(videoLimits.maxTelegramOutputBytes)} document limit.`,
            "input_too_large",
          );
        }
        throw error;
      }
    } else if (isStreamingManifestUrl(url)) {
      downloadedBytes = await downloadWithYtDlp();
    } else {
      downloadedBytes = await downloadRemoteVideo(url, inputPath, {
        maxBytes: videoLimits.maxInputBytes,
        maxBytesForZip: videoLimits.maxTelegramOutputBytes,
        zipLimitMessage: `This ZIP archive exceeds Telegram’s ${formatBytes(videoLimits.maxTelegramOutputBytes)} document limit.`,
        signal: abortController.signal,
        onProgress: (progress) =>
          reportDownloadProgress(progress.downloadedBytes, progress.totalBytes),
      }).catch(async (error: unknown) => {
        if (
          abortController.signal.aborted ||
          (error instanceof RemoteVideoDownloadError &&
            error.code === "input_too_large")
        ) {
          throw error;
        }
        return downloadWithYtDlp();
      });
    }

    if (preparation.cancelled) {
      await unlink(inputPath).catch(() => undefined);
      await editMessage(
        message.chat.id,
        status.message_id,
        zipUrl ? "ZIP download cancelled." : "Video download cancelled.",
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
      throw new RemoteVideoDownloadError(
        `This bot accepts linked videos up to ${videoLimits.maxInputSizeLabel}.`,
        "input_too_large",
      );
    }

    archiveDetected = source === "url" && (await isZipArchiveFile(inputPath));
    if (zipUrl && !archiveDetected) {
      throw new RemoteVideoDownloadError(
        "That link did not return a valid ZIP archive.",
      );
    }
    if (archiveDetected) {
      if (localFile.size > videoLimits.maxTelegramOutputBytes) {
        throw new RemoteVideoDownloadError(
          `This ZIP archive exceeds Telegram’s ${formatBytes(videoLimits.maxTelegramOutputBytes)} document limit.`,
          "input_too_large",
        );
      }
      if (preparation.cancelled) {
        await editMessage(
          message.chat.id,
          status.message_id,
          "ZIP download cancelled.",
        ).catch(() => undefined);
        return;
      }
      const archivePath = path.join(
        JOBS_DIR,
        `${randomUUID()}-${zipArchiveFileName(url)}`,
      );
      await rename(inputPath, archivePath);
      cleanupPath = archivePath;
      preparation.filePath = archivePath;
      preparation.fileSize = localFile.size;
      await editMessage(
        message.chat.id,
        status.message_id,
        `ZIP archive downloaded (${formatBytes(localFile.size)}). Sending it unchanged as a document.`,
      ).catch(() => undefined);
      if (preparation.cancelled) {
        await editMessage(
          message.chat.id,
          status.message_id,
          "ZIP transfer cancelled.",
        ).catch(() => undefined);
        return;
      }
      await telegramCall(
        "sendDocument",
        {
          chat_id: message.chat.id,
          document: pathToFileURL(archivePath).href,
          reply_to_message_id: message.message_id,
          allow_sending_without_reply: true,
          disable_content_type_detection: true,
          caption: `ZIP archive (${formatBytes(localFile.size)}). Extract the video, then send it here to compress.`,
        },
        LONG_TELEGRAM_FILE_TIMEOUT_MS,
        abortController.signal,
      );
      await editMessage(
        message.chat.id,
        status.message_id,
        "ZIP archive sent unchanged. Extract it and send the video back to compress.",
      ).catch(() => undefined);
      return;
    }
    preparation.fileSize = localFile.size;
    await editMessage(
      message.chat.id,
      status.message_id,
      `Video downloaded (${formatBytes(localFile.size)}). Checking its actual resolution; oversized originals will be sent in parts without re-encoding.`,
    ).catch(() => undefined);
    const sourceInfo = await inspectVideoInfo(inputPath, (child) => {
      preparation.child = child;
      if (preparation.cancelled && child) child.kill("SIGTERM");
    });
    if (preparation.cancelled) {
      await editMessage(
        message.chat.id,
        status.message_id,
        "Video preparation cancelled.",
      ).catch(() => undefined);
      return;
    }

    const parsedUrl = new URL(url);
    const fileName =
      source === "tiktok"
        ? "tiktok-video.mp4"
        : path.basename(parsedUrl.pathname);
    const pending: PendingVideo = {
      id,
      key,
      chatId: message.chat.id,
      sourceMessageId: message.message_id,
      sourceUrl: url,
      fileSize: localFile.size,
      fileName,
      filePath: inputPath,
      statusMessageId: status.message_id,
      expiresAt: Date.now() + PENDING_TTL_MS,
      durationSeconds: sourceInfo.durationSeconds,
      sourceWidth: sourceInfo.width,
      sourceHeight: sourceInfo.height,
    };
    const presetChoices = getAvailablePresetResolutions(
      sourceInfo.width,
      sourceInfo.height,
    );
    if (
      localFile.size > videoLimits.maxTelegramOutputBytes ||
      presetChoices.length === 0
    ) {
      await sendOriginalWithoutReencoding(pending, {
        onProcess: (child) => {
          preparation.child = child;
          if (preparation.cancelled && child) child.kill("SIGTERM");
        },
        isCancelled: () => preparation.cancelled,
        signal: abortController.signal,
        onOutputDirectory: (directory) => {
          preparation.outputDirectory = directory ?? undefined;
        },
      });
      return;
    }
    pendingVideos.set(id, pending);
    const readyMessage =
      presetChoices.length === 0
        ? `Video ready · original ${sourceInfo.width}×${sourceInfo.height} · ${formatBytes(localFile.size)}. No lower preset is available. Choose Original ${sourceInfo.width}×${sourceInfo.height} to compress without downscaling, or Custom resolution to reduce dimensions.`
        : `Video ready · original ${sourceInfo.width}×${sourceInfo.height} · ${formatBytes(localFile.size)}. Choose Original ${sourceInfo.width}×${sourceInfo.height} to compress without downscaling or a lower output resolution. Custom resolution is also available.`;
    await editMessage(
      message.chat.id,
      status.message_id,
      readyMessage,
      resolutionKeyboard(sourceInfo.width, sourceInfo.height),
    ).catch(async (error: unknown) => {
      logger.warn(
        { code: errorName(error) },
        "Could not update the linked-video status message",
      );
      const fallback = await sendMessage(
        message.chat.id,
        `Your linked video is ready · original ${sourceInfo.width}×${sourceInfo.height}. Choose Original ${sourceInfo.width}×${sourceInfo.height} to compress without downscaling or one of the lower sizes below. If no button appears, send a smaller custom size such as 360p or 640x360.`,
        resolutionKeyboard(sourceInfo.width, sourceInfo.height),
      ).catch(() => undefined);
      if (fallback) pending.statusMessageId = fallback.message_id;
    });
    if (preparation.cancelled) {
      pendingVideos.delete(id);
      await removeOwnedInput(inputPath);
      await editMessage(
        message.chat.id,
        pending.statusMessageId,
        "Video download cancelled.",
      ).catch(() => undefined);
      return;
    }
    fileTransferredToPending = true;
  } catch (error) {
    const cancelled = preparation.cancelled || abortController.signal.aborted;
    let userMessage: string;
    if (cancelled) {
      userMessage =
        archiveDetected || zipUrl
          ? "ZIP transfer cancelled."
          : "Video download cancelled.";
    } else if (
      archiveDetected &&
      (error instanceof TelegramApiError ||
        error instanceof TelegramTransportError)
    ) {
      userMessage =
        "The ZIP downloaded, but Telegram could not send it. Try again later or use a smaller archive.";
    } else if (error instanceof TikTokDownloadError) {
      userMessage =
        source === "tiktok"
          ? tiktokFailureMessage(error)
          : publicVideoFailureMessage(error, siteName);
    } else if (error instanceof VideoProcessingError) {
      userMessage = error.message;
    } else if (error instanceof RemoteVideoDownloadError) {
      userMessage = error.message;
    } else {
      userMessage =
        "I couldn’t download that video link. Check it and try again.";
    }
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
        "Could not download or send a linked file",
      );
    }
  } finally {
    preparingVideos.delete(id);
    if (!fileTransferredToPending) {
      await unlink(cleanupPath).catch(() => undefined);
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
      ? "Measuring encoding speed; the estimate appears after 5% progress and at least 1 minute."
      : `Estimated time remaining ${formatCountdown((job.etaDeadlineAt - Date.now()) / 1_000)}.`;
  const sameResolutionNote =
    job.resolution === "Same resolution"
      ? " Same-resolution mode keeps the original dimensions and copies the source audio stream."
      : "";
  return `Original size ${formatBytes(job.sourceBytes)} · compressing to ${job.resolution} · pass ${job.attempt}/${job.totalAttempts} · ${percent}. ${eta}${sameResolutionNote}`;
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
  const now = Date.now();
  const compressionBusy = Boolean(activeJob || compressionQueue.size > 0);
  for (const [id, pending] of pendingVideos) {
    const nextExpiry = getNextPendingVideoExpiry(
      pending.expiresAt,
      now,
      PENDING_TTL_MS,
      compressionBusy,
    );
    if (nextExpiry == null) {
      pendingVideos.delete(id);
      void removeOwnedInput(pending.filePath);
      void editMessage(
        pending.chatId,
        pending.statusMessageId,
        "This video selection expired. Send the video again when you are ready.",
      ).catch(() => undefined);
    } else {
      pending.expiresAt = nextExpiry;
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

function isOwnerInboxChat(
  chatType: string | undefined,
  chatId: number,
): boolean {
  return isAuthorizedRailwayVarsChat(
    chatType,
    chatId,
    process.env["TELEGRAM_RESTART_NOTIFICATION_CHAT_ID"],
  );
}

function ownerInboxKeyboard(): Record<string, unknown> {
  return telegramBotMenuKeyboard();
}

function inboxHomeKeyboard(): Record<string, unknown> {
  const userCount = telegramInbox.listUsers(MAX_TELEGRAM_INBOX_MESSAGES).length;
  return {
    inline_keyboard: [
      [
        {
          text: `👥 Users (${userCount})`,
          callback_data: "inbox:users:0",
        },
      ],
    ],
  };
}

function inboxHomeText(): string {
  return [
    "Owner inbox",
    "",
    "Browse recent private-chat users, view their messages, and reply from here.",
    `The inbox keeps up to ${MAX_TELEGRAM_INBOX_MESSAGES} recent messages.`,
  ].join("\n");
}

function inboxUserLabel(user: {
  firstName: string;
  username?: string;
}): string {
  return (user.username ? `@${user.username}` : user.firstName)
    .replace(/\s+/gu, " ")
    .slice(0, 40);
}

function inboxUsersScreen(page: number): {
  text: string;
  replyMarkup: Record<string, unknown>;
} {
  const allUsers = telegramInbox.listUsers(MAX_TELEGRAM_INBOX_MESSAGES);
  const pageCount = Math.max(
    1,
    Math.ceil(allUsers.length / INBOX_USERS_PER_PAGE),
  );
  const selectedPage = Math.min(Math.max(0, page), pageCount - 1);
  const users = allUsers.slice(
    selectedPage * INBOX_USERS_PER_PAGE,
    (selectedPage + 1) * INBOX_USERS_PER_PAGE,
  );
  const rows = users.map((user) => [
    {
      text: `${inboxUserLabel(user)} · ${user.messageCount}`,
      callback_data: `inbox:user:${user.userId}:${selectedPage}`,
    },
  ]);
  const navigation = [];
  if (selectedPage > 0) {
    navigation.push({
      text: "◀ Previous",
      callback_data: `inbox:users:${selectedPage - 1}`,
    });
  }
  if (selectedPage + 1 < pageCount) {
    navigation.push({
      text: "Next ▶",
      callback_data: `inbox:users:${selectedPage + 1}`,
    });
  }
  if (navigation.length > 0) rows.push(navigation);
  rows.push([{ text: "Inbox menu", callback_data: "inbox:home" }]);

  return {
    text:
      allUsers.length === 0
        ? "No recent private-chat users have messaged the bot yet."
        : `Recent users · page ${selectedPage + 1}/${pageCount}\nSelect a user to view recent messages and reply.\n\n${allUsers.length} user(s) in the latest ${MAX_TELEGRAM_INBOX_MESSAGES} messages.`,
    replyMarkup: { inline_keyboard: rows },
  };
}

function formatInboxTimestamp(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatInboxUser(user: {
  userId: number;
  firstName: string;
  username?: string;
  messageCount: number;
  lastMessageAt: number;
}): string {
  const handle = inboxUserLabel(user);
  return `${handle} · ID ${user.userId} · ${user.messageCount} message(s) · last seen ${formatInboxTimestamp(user.lastMessageAt)}`;
}

function inboxUserScreen(
  userId: number,
  page: number,
): { text: string; replyMarkup: Record<string, unknown> } | null {
  const user = telegramInbox.getUser(userId);
  if (!user) return null;
  const messages = telegramInbox.getMessages(userId, 5);
  const conversation = messages.map((entry) => {
    const fileDetails = [
      entry.fileName,
      entry.fileSize == null ? undefined : formatBytes(entry.fileSize),
    ]
      .filter(Boolean)
      .join(" · ");
    const content = entry.text.replace(/\s+/gu, " ").slice(0, 450);
    const details = [fileDetails, content].filter(Boolean).join(" — ");
    return `${formatInboxTimestamp(entry.receivedAt)} · ${entry.contentType}${details ? ` · ${details}` : ""}`;
  });

  return {
    text: `${formatInboxUser(user)}\n\nRecent messages (latest 5; long text is shortened):\n${conversation.join("\n\n") || "No messages saved."}`,
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: "↩ Reply",
            callback_data: `inbox:reply:${user.userId}`,
          },
        ],
        [
          {
            text: "◀ Back to users",
            callback_data: `inbox:users:${page}`,
          },
          { text: "Inbox menu", callback_data: "inbox:home" },
        ],
      ],
    },
  };
}

async function handleInboxCallback(
  callback: TelegramCallbackQuery,
): Promise<void> {
  const message = callback.message;
  if (
    !message ||
    !isOwnerInboxChat(message.chat.type, message.chat.id) ||
    callback.from.id !== message.chat.id
  ) {
    await answerCallback(callback.id, "Owner inbox only.");
    return;
  }

  const data = callback.data ?? "";
  if (data === "inbox:home") {
    await answerCallback(callback.id);
    await editMessage(
      message.chat.id,
      message.message_id,
      inboxHomeText(),
      inboxHomeKeyboard(),
    );
    return;
  }

  const usersMatch = data.match(/^inbox:users:(\d+)$/u);
  if (usersMatch) {
    const screen = inboxUsersScreen(Number(usersMatch[1]));
    await answerCallback(callback.id);
    await editMessage(
      message.chat.id,
      message.message_id,
      screen.text,
      screen.replyMarkup,
    );
    return;
  }

  const userMatch = data.match(/^inbox:user:(\d+):(\d+)$/u);
  if (userMatch) {
    const screen = inboxUserScreen(Number(userMatch[1]), Number(userMatch[2]));
    await answerCallback(
      callback.id,
      screen
        ? undefined
        : "That user's recent messages are no longer available.",
    );
    if (screen) {
      await editMessage(
        message.chat.id,
        message.message_id,
        screen.text,
        screen.replyMarkup,
      );
    }
    return;
  }

  const replyMatch = data.match(/^inbox:reply:(\d+)$/u);
  if (replyMatch) {
    const user = telegramInbox.getUser(Number(replyMatch[1]));
    if (!user) {
      await answerCallback(callback.id, "That user is no longer in the inbox.");
      return;
    }
    await answerCallback(callback.id);
    const prompt = await sendMessage(
      message.chat.id,
      `Reply to ${inboxUserLabel(user)}. Type your response as a reply to this prompt.`,
      {
        force_reply: true,
        selective: true,
        input_field_placeholder: "Type your reply",
      },
    );
    pendingInboxReplies.set(message.chat.id, {
      userId: user.userId,
      promptMessageId: prompt.message_id,
    });
    return;
  }

  await answerCallback(
    callback.id,
    "That inbox button is no longer available.",
  );
}

async function handleMessage(
  message: TelegramMessage,
  updateId: number,
): Promise<void> {
  const text = message.text?.trim();
  const userId = message.from?.id;
  const replyState = pendingInboxReplies.get(message.chat.id);
  if (
    replyState &&
    isOwnerInboxChat(message.chat.type, message.chat.id) &&
    message.reply_to_message?.message_id === replyState.promptMessageId
  ) {
    pendingInboxReplies.delete(message.chat.id);
    const targetUser = telegramInbox.getUser(replyState.userId);
    if (!text || !targetUser) {
      await sendMessage(
        message.chat.id,
        "That reply could not be sent. Open the user's messages and try again.",
      );
      return;
    }
    try {
      await sendMessage(targetUser.chatId, text);
      await sendMessage(
        message.chat.id,
        `Reply sent to ${inboxUserLabel(targetUser)}.`,
      );
    } catch {
      await sendMessage(
        message.chat.id,
        "Telegram could not deliver that reply. The user may have blocked the bot.",
      );
    }
    return;
  }

  if (text === TELEGRAM_BOT_MENU_BUTTONS.openInbox) {
    if (!isOwnerInboxChat(message.chat.type, message.chat.id)) {
      await sendMessage(
        message.chat.id,
        "The owner inbox is available only in the configured private chat.",
      );
      return;
    }
    await sendMessage(message.chat.id, inboxHomeText(), inboxHomeKeyboard());
    return;
  }

  const commandText = telegramBotMenuCommand(text) ?? text;
  const configuredOwnerChatId = parseRestartNotificationChatId(
    process.env["TELEGRAM_RESTART_NOTIFICATION_CHAT_ID"],
  );
  const isIntroCommand = /^\/(?:start|help)(?:@\w+)?(?:\s|$)/iu.test(
    commandText ?? "",
  );
  if (
    message.chat.type === "private" &&
    userId != null &&
    configuredOwnerChatId != null &&
    message.chat.id !== configuredOwnerChatId &&
    !isIntroCommand
  ) {
    const file =
      message.video ??
      message.document ??
      message.animation ??
      message.audio ??
      message.voice ??
      message.video_note ??
      message.sticker ??
      message.photo?.at(-1);
    let contentType = "other";
    if (message.video || isVideoFile(message.document)) contentType = "video";
    else if (message.animation) contentType = "animation";
    else if (message.document) contentType = "document";
    else if (message.photo) contentType = "photo";
    else if (message.audio) contentType = "audio";
    else if (message.voice) contentType = "voice";
    else if (message.video_note) contentType = "video note";
    else if (message.sticker) contentType = "sticker";
    else if (message.contact) contentType = "contact";
    else if (message.location || message.venue) contentType = "location";
    else if (message.poll) contentType = "poll";
    else if (message.text) contentType = "text";

    await telegramInbox
      .record({
        updateId,
        userId,
        chatId: message.chat.id,
        firstName: message.from?.first_name ?? "Unknown user",
        ...(message.from?.username ? { username: message.from.username } : {}),
        contentType,
        text: message.text ?? message.caption ?? "",
        ...(file?.file_name ? { fileName: file.file_name } : {}),
        ...(file?.file_size != null ? { fileSize: file.file_size } : {}),
        receivedAt: message.date == null ? Date.now() : message.date * 1_000,
      })
      .catch((error: unknown) => {
        logger.warn(
          { code: errorName(error) },
          "Could not save a message to the owner inbox",
        );
      });
  }

  if (commandText?.startsWith("/start") || commandText?.startsWith("/help")) {
    await sendMessage(
      message.chat.id,
      [
        `Send me a Telegram video upload up to ${videoLimits.maxTelegramUploadSizeLabel}, paste a direct public video-file link up to ${videoLimits.maxInputSizeLabel}, or send a supported public video page link up to ${videoLimits.maxInputSizeLabel}.`,
        "Send a public ZIP download link and I’ll return the archive unchanged. Extract the video and send it back here to compress. ZIP files must fit Telegram’s document limit.",
        "Public page extraction uses yt-dlp. Common examples include YouTube, TikTok, Instagram, Facebook, X, Reddit, and Vimeo, but support varies by site and extractor version. Direct HLS/DASH manifest links are handled by yt-dlp.",
        "A Netscape-format cookies file can help with content your signed-in account is allowed to view. Cookies are sensitive; never send them in chat. Private or login-only content still needs authorized access, and DRM-protected streams are not supported.",
        "Some sites temporarily rate-limit downloads or change their extractors. The bot reports those separately from login-required, geo-restricted, and unsupported pages.",
        "The bot shows the original dimensions, then offers same-resolution compression and lower output sizes. Same-resolution results are sent only when they are smaller than the source.",
        "Originals above Telegram's 1.9 GB per-file limit are split at keyframes into downloadable parts without re-encoding. If no smaller preset exists, the original is sent unchanged when it fits.",
        "",
        "Use the Status button to check downloads, prepared videos, and compression. Cancel waiting removes the next waiting item; Stop active stops the current compression.",
        "The original file size stays visible while compressing; the estimated countdown updates using this video’s actual encoding speed.",
        "The compressed file is returned here and must fit Telegram's 1.9 GB delivery limit.",
        "Each compressed video replies to the original upload or link, so you can match results when processing several at once.",
        `Compression is one video at a time; up to ${MAX_WAITING_COMPRESSIONS} videos can wait in the queue, with a maximum of ${MAX_OUTSTANDING_VIDEOS} active, queued, preparing, or prepared videos total. Each person can submit up to ${MAX_VIDEO_SUBMISSIONS_PER_USER_PER_HOUR} videos per hour and ${MAX_VIDEO_SUBMISSIONS_PER_USER_PER_DAY} per day.`,
        "When the owner inbox is enabled, the bot keeps up to 1,000 recent private messages (text/captions and basic sender or attachment details) so the owner can review and reply. Media files are not copied into the inbox; avoid sending sensitive information.",
        "Use Chat ID in a private chat to get its ID for restart notifications.",
        "Runtime settings and Open inbox are visible in the menu, but only the configured owner chat can use them.",
        "Buttons are the main controls. Existing slash commands remain available as typed fallbacks.",
      ].join("\n"),
      telegramBotMenuKeyboard(),
    );
    return;
  }

  if (commandText?.startsWith("/chatid")) {
    await sendMessage(
      message.chat.id,
      message.chat.type === "private"
        ? `Private chat ID: ${message.chat.id}\nSet this as TELEGRAM_RESTART_NOTIFICATION_CHAT_ID in Railway to enable restart notifications, runtime settings, and the owner-only inbox.`
        : "For privacy, use Chat ID in a private chat with this bot.",
    );
    return;
  }

  if (
    commandText === "/railwayvars" ||
    commandText?.startsWith("/railwayvars@")
  ) {
    const configuredOwnerChatId =
      process.env["TELEGRAM_RESTART_NOTIFICATION_CHAT_ID"];
    if (
      !isAuthorizedRailwayVarsChat(
        message.chat.type,
        message.chat.id,
        configuredOwnerChatId,
      )
    ) {
      const denial =
        message.chat.type !== "private"
          ? "For privacy, Runtime settings is available only in your configured private chat."
          : parseRestartNotificationChatId(configuredOwnerChatId) == null
            ? "For privacy, Runtime settings is locked until the owner chat is configured. Use Chat ID in your private chat, set that value in Railway, then restart the bot."
            : "For privacy, Runtime settings is available only in the configured private chat.";
      await sendMessage(message.chat.id, denial);
      return;
    }

    const cookiesStatus = await getCookiesRuntimeStatus();
    const cookiesStatusMessage =
      cookiesStatus === "loaded"
        ? "yt-dlp cookies: a readable cookie file is loaded."
        : cookiesStatus === "configured-unavailable"
          ? "yt-dlp cookies: configured, but no readable cookie file was found."
          : "yt-dlp cookies: not configured; public downloads only.";
    await sendMessage(
      message.chat.id,
      `${buildRailwayDeploymentChecklist(process.env)}\n\n${cookiesStatusMessage}`,
    );
    return;
  }

  if (commandText?.startsWith("/status")) {
    const key = userId == null ? "" : makeSessionKey(message.chat.id, userId);
    const queued = key
      ? compressionQueue.toArray().filter((entry) => entry.pending.key === key)
      : [];
    const prepared = key ? pendingForSession(key) : [];
    const preparing = key ? preparationsForSession(key) : [];
    if (activeJob?.key === key) {
      const waiting =
        queued.length > 0
          ? ` You also have ${queued.length} video(s) queued.`
          : "";
      await sendMessage(message.chat.id, `${activeJob.statusText}${waiting}`);
    } else if (queued.length > 0) {
      await sendMessage(
        message.chat.id,
        `You have ${queued.length} video(s) waiting in the compression queue.`,
      );
    } else if (prepared.length > 0) {
      await sendMessage(
        message.chat.id,
        `You have ${prepared.length} video(s) ready. Use the resolution buttons on the message for the video you want to compress.`,
      );
    } else if (preparing.length > 0) {
      const elapsed = Math.max(
        ...preparing.map((preparation) =>
          Math.round((Date.now() - preparation.startedAt) / 1_000),
        ),
      );
      await sendMessage(
        message.chat.id,
        `${preparing.length} video(s) are being prepared${elapsed ? `; the oldest has taken ${formatDuration(elapsed)}` : ""}. Compression has not started for those videos.`,
      );
    } else {
      await sendMessage(message.chat.id, "No video is waiting or processing.");
    }
    return;
  }

  if (commandText?.startsWith("/cancel")) {
    const key = userId == null ? "" : makeSessionKey(message.chat.id, userId);
    const cancelActive = /^\/cancel(?:@\w+)?\s+active\b/i.test(commandText);
    const cancelWaiting = /^\/cancel(?:@\w+)?\s+waiting\b/i.test(commandText);
    if (cancelActive) {
      if (activeJob?.key === key) {
        activeJob.cancelled = true;
        activeJob.child?.kill("SIGTERM");
        await sendMessage(message.chat.id, "Stopping compression...");
      } else {
        await sendMessage(message.chat.id, "No active compression to stop.");
      }
      return;
    }
    const queued = key
      ? compressionQueue.removeFirst((entry) => entry.pending.key === key)
      : undefined;
    if (queued) {
      const preparation = preparingVideos.get(queued.pending.id);
      if (preparation) {
        preparation.cancelled = true;
        preparation.abortController?.abort();
        preparation.child?.kill("SIGTERM");
      }
      await removeOwnedInput(queued.pending.filePath);
      await editMessage(
        queued.pending.chatId,
        queued.pending.statusMessageId,
        "Queued video cancelled.",
      ).catch(() => undefined);
      await sendMessage(
        message.chat.id,
        "Your next queued video was cancelled.",
      );
      return;
    }
    const pending = key ? pendingForSession(key)[0] : undefined;
    if (pending) {
      const pendingPreparation = preparingVideos.get(pending.id);
      if (pendingPreparation) {
        pendingPreparation.cancelled = true;
        pendingPreparation.abortController?.abort();
        pendingPreparation.child?.kill("SIGTERM");
      }
      pendingVideos.delete(pending.id);
      await removeOwnedInput(pending.filePath);
      await editMessage(
        pending.chatId,
        pending.statusMessageId,
        "Video cancelled. Send another video whenever you are ready.",
      ).catch(() => undefined);
      await sendMessage(message.chat.id, "Your waiting video was cancelled.");
      return;
    }
    const preparation = key ? preparationsForSession(key)[0] : undefined;
    if (preparation) {
      preparation.cancelled = true;
      preparation.abortController?.abort();
      preparation.child?.kill("SIGTERM");
      if (preparation.statusMessageId != null) {
        await editMessage(
          preparation.chatId,
          preparation.statusMessageId,
          preparation.source !== "upload"
            ? "Cancelling the video download..."
            : "Cancelling video preparation...",
        ).catch(() => undefined);
      }
      await sendMessage(
        message.chat.id,
        preparation.source !== "upload"
          ? "The video download is being cancelled."
          : "Video preparation is being cancelled.",
      );
      return;
    }
    if (cancelWaiting) {
      await sendMessage(
        message.chat.id,
        "You do not have a waiting video to cancel.",
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

  const tiktokUrl = text ? findTikTokUrl(text) : null;
  if (tiktokUrl) {
    void prepareVideoFromUrl(message, tiktokUrl, "tiktok").catch(
      (error: unknown) => {
        logger.warn(
          { code: errorName(error), updateType: "tiktok_url" },
          "Could not prepare a TikTok link",
        );
        void sendMessage(message.chat.id, tiktokFailureMessage(error)).catch(
          () => undefined,
        );
      },
    );
    return;
  }

  const videoUrl = text ? findHttpUrl(text) : null;
  if (videoUrl) {
    void prepareVideoFromUrl(message, videoUrl).catch((error: unknown) => {
      logger.warn(
        { code: errorName(error), updateType: "video_url" },
        "Could not prepare a linked video",
      );
      void sendMessage(
        message.chat.id,
        publicVideoFailureMessage(error, getVideoSiteName(videoUrl)),
      ).catch(() => undefined);
    });
    return;
  }

  if (userId != null && text && !text.startsWith("/")) {
    const key = makeSessionKey(message.chat.id, userId);
    const ready = pendingForSession(key);
    const pending =
      ready.find((video) => video.awaitingCustomResolution) ??
      (ready.length === 1 ? ready[0] : undefined);
    if (pending) {
      const resolution = parseCustomResolution(text);
      if (!resolution) {
        await sendMessage(
          message.chat.id,
          "Enter a size like 360p or 640x360. Each dimension must be between 144 and 7680 pixels.",
        );
        return;
      }
      if (!reducesSourceDimensions(pending, resolution)) {
        await sendMessage(
          message.chat.id,
          `That target would not reduce this ${pending.sourceWidth}×${pending.sourceHeight} video. Choose Original ${pending.sourceWidth}×${pending.sourceHeight} to compress without downscaling, or enter a smaller target.`,
        );
        return;
      }
      pending.awaitingCustomResolution = false;
      await beginCompression(pending, resolution);
      return;
    }
    if (ready.length > 1 && parseCustomResolution(text)) {
      void sendMessage(
        message.chat.id,
        "Choose Custom resolution on the message for the video you want to compress, then send the target size.",
      );
      return;
    }
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
        "Telegram couldn't retrieve this upload, so it didn't enter the compression queue. It didn't cancel any other video. Please send it again or try a direct video link.",
      ).catch(() => undefined);
    });
    return;
  }

  if (text && !text.startsWith("/")) {
    await sendMessage(
      message.chat.id,
      "Send a video file or paste a public link. Tap Help below for instructions.",
    );
  }
}

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  const message = callback.message;
  if (!message || !callback.data) {
    await answerCallback(callback.id);
    return;
  }
  if (callback.data.startsWith("inbox:")) {
    await handleInboxCallback(callback);
    return;
  }
  const key = makeSessionKey(message.chat.id, callback.from.id);
  const pending = [...pendingVideos.values()].find(
    (video) =>
      video.key === key && video.statusMessageId === message.message_id,
  );
  const nextExpiry = pending
    ? getNextPendingVideoExpiry(
        pending.expiresAt,
        Date.now(),
        PENDING_TTL_MS,
        Boolean(activeJob || compressionQueue.size > 0),
      )
    : null;
  if (!pending || nextExpiry == null) {
    if (pending) {
      pendingVideos.delete(pending.id);
      await removeOwnedInput(pending.filePath);
    }
    await answerCallback(callback.id, "This video selection expired.");
    return;
  }
  pending.expiresAt = nextExpiry;

  const choice = callback.data.replace("resolution:", "");
  if (choice === "cancel") {
    const preparation = preparingVideos.get(pending.id);
    if (preparation) {
      preparation.cancelled = true;
      preparation.abortController?.abort();
    }
    pendingVideos.delete(pending.id);
    await answerCallback(callback.id, "Video cancelled.");
    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      "Video cancelled. Send another video whenever you are ready.",
    ).catch(() => undefined);
    await removeOwnedInput(pending.filePath);
    return;
  }
  if (choice === "custom") {
    pending.awaitingCustomResolution = true;
    await answerCallback(callback.id);
    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      `Enter a target below ${pending.sourceWidth}×${pending.sourceHeight}, using NNNp or widthxheight format (for example, 960p or 1280x720). The aspect ratio is preserved; upscaling is rejected.`,
      {
        inline_keyboard: [
          [
            {
              text: `Original ${pending.sourceWidth}×${pending.sourceHeight}`,
              callback_data: "resolution:same",
            },
            { text: "Cancel", callback_data: "resolution:cancel" },
          ],
        ],
      },
    );
    return;
  }

  const resolution =
    choice === SAME_RESOLUTION_CHOICE
      ? getSameResolutionResolution(pending.sourceWidth, pending.sourceHeight)
      : findResolution(choice);
  if (!resolution) {
    await answerCallback(callback.id, "That resolution is not available.");
    return;
  }
  if (
    choice !== SAME_RESOLUTION_CHOICE &&
    !reducesSourceDimensions(pending, resolution)
  ) {
    await answerCallback(
      callback.id,
      `Choose a resolution below ${pending.sourceWidth}×${pending.sourceHeight}.`,
    );
    return;
  }

  const queued = Boolean(activeJob || compressionQueue.size > 0);
  await answerCallback(
    callback.id,
    queued
      ? `Added ${resolution.label} video to the queue.`
      : `Starting ${resolution.label} compression.`,
  );
  await beginCompression(pending, resolution);
}

async function beginCompression(
  pending: PendingVideo,
  resolution: VideoResolution,
): Promise<void> {
  pendingVideos.delete(pending.id);
  if (activeJob) {
    if (!compressionQueue.enqueue({ pending, resolution })) {
      pendingVideos.set(pending.id, pending);
      await editMessage(
        pending.chatId,
        pending.statusMessageId,
        "The compression queue is full. Your video is still ready; try again when a queued video finishes.",
        resolutionKeyboard(pending.sourceWidth, pending.sourceHeight),
      ).catch(() => undefined);
      return;
    }
    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      `Added to the compression queue at position ${compressionQueue.size + 1}. Your ${resolution.label} video will start after the current job.`,
    ).catch(() => undefined);
    return;
  }

  const job: ActiveJob = {
    videoId: pending.id,
    key: pending.key,
    chatId: pending.chatId,
    inputPath: pending.filePath,
    cancelled: false,
    child: null,
    resolution: resolution.label,
    sourceBytes: pending.fileSize,
    statusText: `Starting ${resolution.label} compression. Original size: ${formatBytes(pending.fileSize)}. Measuring encoding speed for the countdown.`,
    attempt: 1,
    totalAttempts: resolution.preserveSourceDimensions
      ? SAME_RESOLUTION_COMPRESSION_CRF_LEVELS.length
      : COMPRESSION_CRF_LEVELS.length,
    progressPercent: 0,
    etaDeadlineAt: null,
    attemptStartedAt: Date.now(),
  };
  activeJob = job;
  await editMessage(
    pending.chatId,
    pending.statusMessageId,
    job.statusText,
  ).catch(() => undefined);

  void runCompressionJob(job, pending, resolution);
}

function startNextQueuedCompression(): void {
  if (activeJob || stopping) return;
  const next = compressionQueue.dequeue();
  if (!next) return;
  void beginCompression(next.pending, next.resolution);
}

async function runCompressionJob(
  job: ActiveJob,
  pending: PendingVideo,
  resolution: VideoResolution,
): Promise<void> {
  let inputPath: string | null = null;
  let retainInputForRetry = false;
  const outputDirectory = path.join(JOBS_DIR, randomUUID());
  const outputPath = path.join(
    outputDirectory,
    compressedVideoFileName(pending.fileName),
  );
  job.outputDirectory = outputDirectory;
  try {
    await mkdir(outputDirectory, { recursive: true });
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
        `This video exceeds the ${videoLimits.maxInputSizeLabel} processing limit.`,
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
        job.statusText = `Original size ${formatBytes(job.sourceBytes)} · compressing ${resolution.label} for a ${formatDuration(info.durationSeconds)} video. Measuring encoding speed; the estimate appears after 5% progress and at least 1 minute.`;
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
      isCancelled: () => job.cancelled,
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
        const remainingSeconds = estimateRemainingSeconds(
          progress.fraction,
          attemptElapsedSeconds,
        );
        job.etaDeadlineAt =
          remainingSeconds == null ? null : now + remainingSeconds * 1_000;
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
      `Compression finished (${result.width}×${result.height}). Original: ${formatBytes(pending.fileSize)} · compressed: ${formatBytes(result.outputBytes)}.${result.removedSceneSeconds ? ` Removed ${result.removedSceneSeconds.toFixed(1)} seconds of frozen/blank scenes.` : ""} Sending it to Telegram...`,
    ).catch(() => undefined);

    await telegramCall(
      "sendVideo",
      {
        chat_id: pending.chatId,
        video: pathToFileURL(result.outputPath).href,
        reply_to_message_id: pending.sourceMessageId,
        allow_sending_without_reply: true,
        duration: Math.max(1, Math.round(result.durationSeconds)),
        width: result.width,
        height: result.height,
        caption: buildCompressionResultCaption(
          `Compressed to ${result.width}×${result.height} · original ${formatBytes(pending.fileSize)} → ${formatBytes(result.outputBytes)}`,
          pending.sourceUrl,
          result.removedSceneSeconds,
        ),
        supports_streaming: true,
      },
      LONG_TELEGRAM_FILE_TIMEOUT_MS,
    );

    await editMessage(
      pending.chatId,
      pending.statusMessageId,
      `Done. The compressed video has been sent. Original: ${formatBytes(pending.fileSize)} · outcome: ${formatBytes(result.outputBytes)}.${result.removedSceneSeconds ? ` Removed ${result.removedSceneSeconds.toFixed(1)} seconds of frozen/blank scenes.` : ""}`,
    ).catch(() => undefined);
  } catch (error) {
    logger.warn(
      { code: errorName(error), chatId: job.chatId },
      "Video compression job failed",
    );
    if (!job.cancelled && isRetryableResolutionError(error)) {
      const smallerPresets = getSmallerPresetResolutions(
        pending.sourceWidth,
        pending.sourceHeight,
        resolution,
      );
      if (smallerPresets.length === 0 || resolution.preserveSourceDimensions) {
        await sendOriginalWithoutReencoding(pending, {
          onProcess: (child) => {
            job.child = child;
            if (job.cancelled && child) child.kill("SIGTERM");
          },
          isCancelled: () => job.cancelled,
          onOutputDirectory: (directory) => {
            job.losslessOutputDirectory = directory ?? undefined;
          },
        });
      } else {
        pending.awaitingCustomResolution = false;
        pending.expiresAt = Date.now() + PENDING_TTL_MS;
        pendingVideos.set(pending.id, pending);
        retainInputForRetry = true;

        const sourceNote = pending.sourceUrl
          ? pending.sourceUrl.length <= 3_000
            ? ` Source link: ${pending.sourceUrl}`
            : " The source link is in your original message."
          : " The original remains in your earlier message.";
        const message =
          error.code === "output_not_smaller"
            ? `That target couldn't make this video smaller at high quality. Choose one of the lower resolutions or enter a custom size.`
            : `That output is still above Telegram's size limit. Choose a lower resolution or custom size to try again.${sourceNote}`;
        const keyboard = resolutionKeyboard(
          pending.sourceWidth,
          pending.sourceHeight,
          resolution.label,
          resolution,
        );
        try {
          await editMessage(
            pending.chatId,
            pending.statusMessageId,
            message,
            keyboard,
          );
        } catch {
          const fallback = await sendMessage(
            pending.chatId,
            message,
            keyboard,
          ).catch(() => undefined);
          if (fallback) pending.statusMessageId = fallback.message_id;
        }
      }
    } else {
      const userMessage =
        error instanceof VideoProcessingError
          ? error.message
          : "The video could not be processed. Please try again.";
      await editMessage(
        pending.chatId,
        pending.statusMessageId,
        job.cancelled ? "Compression cancelled." : userMessage,
      ).catch(() => undefined);
    }
  } finally {
    await unlink(outputPath).catch(() => undefined);
    await rmdir(outputDirectory).catch(() => undefined);
    if (inputPath && !retainInputForRetry) await removeOwnedInput(inputPath);
    if (activeJob === job) {
      activeJob = null;
      startNextQueuedCompression();
    }
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.message) {
    await handleMessage(update.message, update.update_id);
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
  await telegramInbox.load().catch((error: unknown) => {
    logger.warn(
      { code: errorName(error) },
      "Could not load the saved owner inbox; continuing with an empty inbox",
    );
  });
  await cleanupOrphanedJobFiles();
  startJobArtifactCleanup();

  try {
    localApiProcess = startLocalBotApi();
    const bot = await waitForLocalApi(localApiProcess);
    const webhook = await telegramCall<{ url: string }>("getWebhookInfo");
    if (webhook.url) {
      throw new Error(
        "This Telegram bot already has a webhook configured. Remove it before using the local polling bot.",
      );
    }
    // Keep typed slash-command handlers for compatibility while using buttons
    // as the bot's visible primary menu.
    await telegramCall("setMyCommands", { commands: [] });
    await telegramCall("setMyDescription", {
      description:
        "Compress videos from uploads, direct links, or supported public video pages. When enabled, the owner can review recent private messages and reply; media files are not copied into the inbox.",
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

    const configuredNotificationChatId =
      process.env["TELEGRAM_RESTART_NOTIFICATION_CHAT_ID"];
    const notificationChatId = parseRestartNotificationChatId(
      configuredNotificationChatId,
    );
    if (configuredNotificationChatId?.trim() && notificationChatId == null) {
      logger.warn(
        "TELEGRAM_RESTART_NOTIFICATION_CHAT_ID must be a positive private chat ID; startup notification is disabled",
      );
    } else if (notificationChatId != null) {
      void sendMessage(
        notificationChatId,
        "The bot restarted successfully. Use the buttons to check status or open the owner inbox.",
        ownerInboxKeyboard(),
      ).catch((error: unknown) => {
        logger.warn(
          { code: errorName(error) },
          "Could not send the startup notification",
        );
      });
    }

    return stopTelegramVideoBot;
  } catch (error) {
    stopTelegramVideoBot();
    throw error;
  }
}

export function stopTelegramVideoBot(): void {
  stopping = true;
  if (jobArtifactCleanupTimer) {
    clearInterval(jobArtifactCleanupTimer);
    jobArtifactCleanupTimer = null;
  }
  activeJob?.child?.kill("SIGTERM");
  for (const preparation of preparingVideos.values()) {
    preparation.cancelled = true;
    preparation.abortController?.abort();
    preparation.child?.kill("SIGTERM");
  }
  for (const pending of pendingVideos.values()) {
    void removeOwnedInput(pending.filePath);
  }
  for (const queued of compressionQueue.clear()) {
    void removeOwnedInput(queued.pending.filePath);
  }
  pendingVideos.clear();
  localApiProcess?.kill("SIGTERM");
  localApiProcess = null;
  botToken = "";
}
