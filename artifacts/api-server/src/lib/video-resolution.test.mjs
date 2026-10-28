import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_RESOLUTIONS, parseCustomResolution } from "./video-processing.ts";

const presetByLabel = new Map(
  PRESET_RESOLUTIONS.map((resolution) => [resolution.label, resolution]),
);

test("offers 240p and 360p as selectable preset resolutions", () => {
  assert.equal(presetByLabel.get("240p")?.maxHeight, 240);
  assert.equal(presetByLabel.get("360p")?.maxHeight, 360);
});

test("accepts 240p and 360p as custom resolution inputs too", () => {
  assert.deepEqual(parseCustomResolution("240p"), {
    label: "240p",
    maxWidth: 7680,
    maxHeight: 240,
  });
  assert.deepEqual(parseCustomResolution("360p"), {
    label: "360p",
    maxWidth: 7680,
    maxHeight: 360,
  });
});
