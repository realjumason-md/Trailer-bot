import assert from "node:assert/strict";
import test from "node:test";
import { getNextPendingVideoExpiry } from "./pending-video-expiration.ts";

test("keeps a pending resolution choice through a long compression backlog", () => {
  const ttlMs = 30 * 60 * 1_000;
  let expiresAt = 30 * 60 * 1_000;

  for (let now = expiresAt + 1; now < 3 * 60 * 60 * 1_000; now += 60_000) {
    const nextExpiry = getNextPendingVideoExpiry(
      expiresAt,
      now,
      ttlMs,
      true,
    );
    assert.notEqual(nextExpiry, null);
    expiresAt = nextExpiry;
  }
});

test("retains the inactivity deadline while the compressor is idle", () => {
  assert.equal(getNextPendingVideoExpiry(10_000, 9_000, 30_000, false), 10_000);
});

test("expires an old pending choice after compression becomes idle", () => {
  assert.equal(getNextPendingVideoExpiry(10_000, 10_001, 30_000, false), null);
});

test("renews the selection deadline when compression is still busy", () => {
  assert.equal(getNextPendingVideoExpiry(10_000, 10_001, 30_000, true), 40_001);
});
