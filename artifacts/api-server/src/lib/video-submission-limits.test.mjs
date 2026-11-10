import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_VIDEO_SUBMISSIONS_PER_USER_PER_HOUR,
  MAX_VIDEO_SUBMISSIONS_PER_USER_PER_DAY,
  recordVideoSubmission,
  VIDEO_SUBMISSION_DAY_MS,
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
    assert.equal(blocked.limit, "hour");
    assert.equal(blocked.retryAfterMs, VIDEO_SUBMISSION_WINDOW_MS - 10);
  }

  assert.equal(
    recordVideoSubmission(submissions, 42, now + VIDEO_SUBMISSION_WINDOW_MS)
      .allowed,
    true,
  );
});

test("limits each user to twenty submissions in a rolling day", () => {
  const submissions = new Map();
  const start = 3_000_000;
  let submitted = 0;

  for (const hour of [0, 2, 4, 6]) {
    const count = hour === 6 ? 2 : 6;
    for (let index = 0; index < count; index++) {
      assert.equal(
        recordVideoSubmission(submissions, 7, start + hour * 60 * 60 * 1_000)
          .allowed,
        true,
      );
      submitted += 1;
    }
  }
  assert.equal(submitted, MAX_VIDEO_SUBMISSIONS_PER_USER_PER_DAY);

  const blocked = recordVideoSubmission(
    submissions,
    7,
    start + 6 * 60 * 60 * 1_000 + 1,
  );
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.equal(blocked.limit, "day");
    assert.equal(
      blocked.retryAfterMs,
      VIDEO_SUBMISSION_DAY_MS - 6 * 60 * 60 * 1_000 - 1,
    );
  }

  assert.equal(
    recordVideoSubmission(submissions, 7, start + VIDEO_SUBMISSION_DAY_MS)
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
    recordVideoSubmission(submissions, 2, now + VIDEO_SUBMISSION_DAY_MS)
      .allowed,
    true,
  );
  assert.deepEqual(submissions.get(1), undefined);
});
