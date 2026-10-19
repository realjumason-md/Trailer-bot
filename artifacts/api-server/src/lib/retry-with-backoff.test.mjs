import assert from "node:assert/strict";
import test from "node:test";
import { retryWithBackoff } from "./retry-with-backoff.ts";

test("retries transient failures with bounded backoff", async () => {
  let attempts = 0;
  const delays = [];
  const result = await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("temporary transport failure");
      return "ready";
    },
    {
      maxAttempts: 3,
      delayMs: (attempt) => attempt * 500,
      shouldRetry: (error) => error instanceof TypeError,
      wait: async (milliseconds) => delays.push(milliseconds),
    },
  );

  assert.equal(result, "ready");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test("does not retry a non-transient failure", async () => {
  let attempts = 0;
  const error = new Error("invalid file identifier");

  await assert.rejects(
    retryWithBackoff(
      async () => {
        attempts += 1;
        throw error;
      },
      {
        maxAttempts: 3,
        delayMs: () => 1,
        shouldRetry: () => false,
        wait: async () => undefined,
      },
    ),
    error,
  );
  assert.equal(attempts, 1);
});

test("rejects invalid retry attempt counts", async () => {
  await assert.rejects(
    retryWithBackoff(async () => "unused", {
      maxAttempts: 0,
      delayMs: () => 0,
      shouldRetry: () => false,
    }),
    /maxAttempts must be a positive integer/,
  );
});
