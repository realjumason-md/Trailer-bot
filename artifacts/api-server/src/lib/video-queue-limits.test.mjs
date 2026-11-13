import assert from "node:assert/strict";
import test from "node:test";
import {
  canAcceptVideo,
  MAX_OUTSTANDING_VIDEOS,
  MAX_WAITING_COMPRESSIONS,
} from "./video-queue-limits.ts";

test("allows ten waiting videos plus one active or preparing video", () => {
  assert.equal(MAX_WAITING_COMPRESSIONS, 10);
  assert.equal(MAX_OUTSTANDING_VIDEOS, 11);
  for (
    let outstanding = 0;
    outstanding < MAX_OUTSTANDING_VIDEOS;
    outstanding += 1
  ) {
    assert.equal(canAcceptVideo(outstanding), true);
  }
  assert.equal(canAcceptVideo(MAX_OUTSTANDING_VIDEOS - 1), true);
  assert.equal(canAcceptVideo(MAX_OUTSTANDING_VIDEOS), false);
});
