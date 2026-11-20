export const MAX_VIDEO_INPUT_BYTES = 5_000_000_000;
export const VIDEO_INPUT_LIMIT_LABEL = "5 GB";

export const MAX_TELEGRAM_UPLOAD_INPUT_BYTES = 4 * 1024 * 1024 * 1024;
export const TELEGRAM_UPLOAD_INPUT_LIMIT_LABEL = "4 GB";

// Leave a safety margin below the Local Bot API server's 2,000 MB upload cap.
export const MAX_TELEGRAM_OUTPUT_BYTES = 1_900_000_000;
