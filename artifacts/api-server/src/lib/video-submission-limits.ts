export const MAX_VIDEO_SUBMISSIONS_PER_USER_PER_HOUR = 6;
export const MAX_VIDEO_SUBMISSIONS_PER_USER_PER_DAY = 20;
export const VIDEO_SUBMISSION_WINDOW_MS = 60 * 60 * 1_000;
export const VIDEO_SUBMISSION_DAY_MS = 24 * VIDEO_SUBMISSION_WINDOW_MS;

export type VideoSubmissionLimitResult =
  | { allowed: true; retryAfterMs: 0 }
  | {
      allowed: false;
      limit: "hour" | "day";
      retryAfterMs: number;
    };

/**
 * Records an accepted video submission in a process-local rolling window.
 * Expired entries for other users are pruned as submissions arrive.
 */
export function recordVideoSubmission(
  submissions: Map<number, number[]>,
  userId: number,
  now = Date.now(),
): VideoSubmissionLimitResult {
  const cutoff = now - VIDEO_SUBMISSION_DAY_MS;
  for (const [trackedUserId, timestamps] of submissions) {
    const recent = timestamps.filter(
      (timestamp) => timestamp > cutoff && timestamp <= now,
    );
    if (recent.length === 0) submissions.delete(trackedUserId);
    else submissions.set(trackedUserId, recent);
  }

  const recent = submissions.get(userId) ?? [];
  const hourCutoff = now - VIDEO_SUBMISSION_WINDOW_MS;
  const recentThisHour = recent.filter((timestamp) => timestamp > hourCutoff);
  if (recentThisHour.length >= MAX_VIDEO_SUBMISSIONS_PER_USER_PER_HOUR) {
    const nextAvailableAt =
      Math.min(...recentThisHour) + VIDEO_SUBMISSION_WINDOW_MS;
    return {
      allowed: false,
      limit: "hour",
      retryAfterMs: Math.max(1, nextAvailableAt - now),
    };
  }
  if (recent.length >= MAX_VIDEO_SUBMISSIONS_PER_USER_PER_DAY) {
    const nextAvailableAt = Math.min(...recent) + VIDEO_SUBMISSION_DAY_MS;
    return {
      allowed: false,
      limit: "day",
      retryAfterMs: Math.max(1, nextAvailableAt - now),
    };
  }

  submissions.set(userId, [...recent, now]);
  return { allowed: true, retryAfterMs: 0 };
}
