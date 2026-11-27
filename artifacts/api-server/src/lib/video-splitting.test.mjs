import assert from "node:assert/strict";
import test from "node:test";
import { getLosslessSplitPlan, videoLimits } from "./video-processing.ts";

test("plans two or three original-quality parts for oversized videos", () => {
  assert.equal(getLosslessSplitPlan(2_100_000_000, 3_600)?.partCount, 2);
  assert.equal(getLosslessSplitPlan(4_000_000_000, 7_200)?.partCount, 3);
  assert.equal(getLosslessSplitPlan(5_000_000_000, 10_800)?.partCount, 3);
});

test("does not plan a split when one Telegram file is sufficient", () => {
  assert.equal(
    getLosslessSplitPlan(videoLimits.maxTelegramOutputBytes, 600),
    null,
  );
});

test("rejects invalid source sizes and durations", () => {
  assert.equal(getLosslessSplitPlan(0, 60), null);
  assert.equal(getLosslessSplitPlan(2_000_000_000, 0), null);
  assert.equal(getLosslessSplitPlan(2_000_000_000, Number.NaN), null);
});
