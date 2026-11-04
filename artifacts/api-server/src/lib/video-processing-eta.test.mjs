import assert from "node:assert/strict";
import test from "node:test";
import { estimateRemainingSeconds } from "./video-processing.ts";

test("waits for enough progress before showing an ETA", () => {
  assert.equal(estimateRemainingSeconds(0.005, 600), null);
  assert.equal(estimateRemainingSeconds(0.04, 120), null);
  assert.equal(estimateRemainingSeconds(0.05, 59), null);
});

test("estimates remaining seconds from the elapsed average after the threshold", () => {
  assert.equal(estimateRemainingSeconds(0.25, 120), 360);
});

test("handles completion and invalid progress safely", () => {
  assert.equal(estimateRemainingSeconds(1, 120), 0);
  assert.equal(estimateRemainingSeconds(Number.NaN, 120), null);
  assert.equal(estimateRemainingSeconds(1.1, 120), null);
  assert.equal(estimateRemainingSeconds(0.5, Number.NaN), null);
});
