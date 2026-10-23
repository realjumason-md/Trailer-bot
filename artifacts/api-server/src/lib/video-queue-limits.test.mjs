import assert from "node:assert/strict";
import test from "node:test";
import {
  canAcceptVideo,
  MAX_OUTSTANDING_VIDEOS,
} from "./video-queue-limits.ts";

test("accepts five videos sent together without a lower preparation cap", () => {
  for (let outstanding = 0; outstanding < 5; outstanding += 1) {
    assert.equal(canAcceptVideo(outstanding), true);
  }
});

test("retains the six-video total limit", () => {
  assert.equal(canAcceptVideo(MAX_OUTSTANDING_VIDEOS - 1), true);
  assert.equal(canAcceptVideo(MAX_OUTSTANDING_VIDEOS), false);
});
