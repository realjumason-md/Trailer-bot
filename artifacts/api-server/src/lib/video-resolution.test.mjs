import assert from "node:assert/strict";
import test from "node:test";
import {
  getAvailablePresetResolutions,
  getOutputDimensions,
  PRESET_RESOLUTIONS,
  parseCustomResolution,
} from "./video-processing.ts";

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
    shortSide: 240,
  });
  assert.deepEqual(parseCustomResolution("360p"), {
    label: "360p",
    maxWidth: 7680,
    maxHeight: 360,
    shortSide: 360,
  });
});

test("only offers preset resolutions that reduce the source dimensions", () => {
  assert.deepEqual(
    getAvailablePresetResolutions(1280, 720).map(({ label }) => label),
    ["240p", "360p", "480p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(1920, 1080).map(({ label }) => label),
    ["240p", "360p", "480p", "720p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(3840, 2160).map(({ label }) => label),
    ["240p", "360p", "480p", "720p", "1080p", "1440p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(1080, 1920).map(({ label }) => label),
    ["240p", "360p", "480p", "720p"],
  );
});

test("fits portrait presets by short edge without upscaling", () => {
  const preset = PRESET_RESOLUTIONS.find(({ label }) => label === "720p");
  assert.ok(preset);
  const output = getOutputDimensions(1080, 1920, preset);
  assert.ok(output.width <= 1080);
  assert.ok(output.height <= 1920);
  assert.equal(output.width, 720);
  assert.equal(output.height, 1280);
});

test("returns no standard downscale presets for invalid or tiny sources", () => {
  assert.deepEqual(getAvailablePresetResolutions(0, 0), []);
  assert.deepEqual(getAvailablePresetResolutions(320, 240), []);
});
