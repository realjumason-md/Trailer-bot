import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_VIDEO_SUBMISSIONS_PER_USER_PER_HOUR,
  recordVideoSubmission,
  VIDEO_SUBMISSION_WINDOW_MS,
} from "./video-submission-limits.ts";

test("limits each user to six submissions in a rolling hour", () => {
  const submissions = new Map();
  const now = 1_000_000;

  for (
    let index = 0;
    index < MAX_VIDEO_SUBMISSIONS_PER_USER_PER_HOUR;
    index++
  ) {
    assert.deepEqual(recordVideoSubmission(submissions, 42, now + index), {
      allowed: true,
      retryAfterMs: 0,
    });
  }

  const blocked = recordVideoSubmission(submissions, 42, now + 10);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.equal(blocked.retryAfterMs, VIDEO_SUBMISSION_WINDOW_MS - 10);
  }

  assert.equal(
    recordVideoSubmission(submissions, 42, now + VIDEO_SUBMISSION_WINDOW_MS)
      .allowed,
    true,
  );
});

test("tracks users independently and prunes expired submissions", () => {
  const submissions = new Map();
  const now = 2_000_000;

  assert.equal(recordVideoSubmission(submissions, 1, now).allowed, true);
  assert.equal(recordVideoSubmission(submissions, 2, now).allowed, true);
  assert.equal(
    recordVideoSubmission(submissions, 2, now + VIDEO_SUBMISSION_WINDOW_MS)
      .allowed,
    true,
  );
  assert.deepEqual(submissions.get(1), undefined);
});
