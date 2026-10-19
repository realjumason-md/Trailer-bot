type RetryOptions = {
  maxAttempts: number;
  delayMs: (failedAttempt: number) => number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (
    error: unknown,
    nextAttempt: number,
    delayMilliseconds: number,
  ) => void;
  wait?: (milliseconds: number) => Promise<void>;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer.");
  }

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= options.maxAttempts || !options.shouldRetry(error)) {
        throw error;
      }

      const delayMilliseconds = Math.max(
        0,
        options.delayMs(attempt),
      );
      options.onRetry?.(error, attempt + 1, delayMilliseconds);
      await (options.wait ?? sleep)(delayMilliseconds);
    }
  }

  throw new Error("Retry loop ended unexpectedly.");
}
