export const DEFAULT_REMOTE_DOWNLOAD_TIMEOUT_MS = 12 * 60 * 60 * 1_000;

export function createDownloadDeadline(
  parentSignal: AbortSignal,
  timeoutMs = DEFAULT_REMOTE_DOWNLOAD_TIMEOUT_MS,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("The download time limit must be positive.");
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(),
    Math.max(1, Math.ceil(timeoutMs)),
  );

  return {
    signal: AbortSignal.any([parentSignal, timeoutController.signal]),
    didTimeout: () => timeoutController.signal.aborted && !parentSignal.aborted,
    dispose: () => clearTimeout(timer),
  };
}

export function waitForWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new Error("Operation cancelled."));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
