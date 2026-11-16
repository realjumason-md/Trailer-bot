import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSceneRemovalFilters,
  createSceneRemovalPlan,
  parseSceneDetectionLog,
} from "./scene-cleaning.ts";

test("parses only freeze and black events longer than their thresholds", () => {
  const log = [
    "[Parsed_freezedetect] lavfi.freezedetect.freeze_start: 2.000000",
    "[Parsed_freezedetect] lavfi.freezedetect.freeze_duration: 0.600000",
    "[Parsed_freezedetect] lavfi.freezedetect.freeze_start: 5.000000",
    "[Parsed_freezedetect] lavfi.freezedetect.freeze_duration: 1.200000",
    "[blackdetect] black_start:3.000000 black_end:3.500000 black_duration:0.500000",
    "[blackdetect] black_start:8.000000 black_end:8.700000 black_duration:0.700000",
  ].join("\n");

  assert.deepEqual(parseSceneDetectionLog(log, 10), [
    { startSeconds: 5, endSeconds: 6.2, type: "freeze" },
    { startSeconds: 8, endSeconds: 8.7, type: "black" },
  ]);
});

test("closes a freeze that continues to the end of the video", () => {
  const log = "[Parsed_freezedetect] lavfi.freezedetect.freeze_start: 8.000000";

  assert.deepEqual(parseSceneDetectionLog(log, 9), [
    { startSeconds: 8, endSeconds: 9, type: "freeze" },
  ]);
});

test("merges overlapping intervals before enforcing the removal cap", () => {
  const plan = createSceneRemovalPlan(
    [
      { startSeconds: 1, endSeconds: 2, type: "freeze" },
      { startSeconds: 1.5, endSeconds: 2.5, type: "black" },
      { startSeconds: 7, endSeconds: 8, type: "freeze" },
    ],
    10,
  );

  assert.deepEqual(plan, {
    intervals: [
      { startSeconds: 1, endSeconds: 2.5 },
      { startSeconds: 7, endSeconds: 8 },
    ],
    removedSeconds: 2.5,
  });
});

test("rejects plans removing over 25% or leaving under three seconds", () => {
  assert.equal(
    createSceneRemovalPlan(
      [{ startSeconds: 1, endSeconds: 3.6, type: "freeze" }],
      10,
    ),
    null,
  );
  assert.equal(
    createSceneRemovalPlan(
      [{ startSeconds: 1, endSeconds: 3.1, type: "black" }],
      5,
    ),
    null,
  );
});

test("rechecks thresholds after clipping intervals to the video bounds", () => {
  assert.equal(
    createSceneRemovalPlan(
      [{ startSeconds: -1, endSeconds: 0.5, type: "freeze" }],
      10,
    ),
    null,
  );
});

test("builds matching video and audio timeline filters", () => {
  const filters = buildSceneRemovalFilters([
    { startSeconds: 1, endSeconds: 2 },
    { startSeconds: 4, endSeconds: 5.5 },
  ]);

  assert.match(filters.video, /^select='not\(/);
  assert.match(filters.video, /setpts='PTS-STARTPTS-/);
  assert.match(filters.audio, /^aselect='not\(/);
  assert.match(filters.audio, /asetpts='PTS-STARTPTS-/);
  assert.equal(filters.video.includes("1.000000"), true);
  assert.equal(filters.audio.includes("1.000000"), true);
});
