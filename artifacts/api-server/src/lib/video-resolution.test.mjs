import assert from "node:assert/strict";
import test from "node:test";
import {
  getAvailablePresetResolutions,
  getOutputDimensions,
  isRetryableResolutionError,
  PRESET_RESOLUTIONS,
  parseCustomResolution,
  VideoProcessingError,
} from "./video-processing.ts";

const presetByLabel = new Map(
  PRESET_RESOLUTIONS.map((resolution) => [resolution.label, resolution]),
);

test("offers 240p and 360p as selectable preset resolutions", () => {
  assert.equal(presetByLabel.get("240p")?.maxHeight, 240);
  assert.equal(presetByLabel.get("360p")?.maxHeight, 360);
  assert.equal(presetByLabel.get("420p")?.maxHeight, 420);
  assert.equal(presetByLabel.get("960p")?.maxHeight, 960);
});

test("accepts arbitrary custom p targets", () => {
  assert.deepEqual(parseCustomResolution("960p"), {
    label: "960p",
    maxWidth: 7680,
    maxHeight: 960,
    shortSide: 960,
  });
  assert.deepEqual(parseCustomResolution("999p"), {
    label: "999p",
    maxWidth: 7680,
    maxHeight: 999,
    shortSide: 999,
  });
});

test("only offers preset resolutions that reduce the source dimensions", () => {
  assert.deepEqual(
    getAvailablePresetResolutions(1280, 720).map(({ label }) => label),
    ["240p", "360p", "420p", "480p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(1920, 1080).map(({ label }) => label),
    ["240p", "360p", "420p", "480p", "720p", "960p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(3840, 2160).map(({ label }) => label),
    ["240p", "360p", "420p", "480p", "720p", "960p", "1080p", "1440p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(1080, 1920).map(({ label }) => label),
    ["240p", "360p", "420p", "480p", "720p", "960p"],
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

test("maps 420p to the correct landscape output dimensions", () => {
  const preset = PRESET_RESOLUTIONS.find(({ label }) => label === "420p");
  assert.ok(preset);
  assert.deepEqual(getOutputDimensions(1280, 720, preset), {
    width: 746,
    height: 420,
  });
});

test("maps 960p to the correct 4K landscape output dimensions", () => {
  const resolution = parseCustomResolution("960p");
  assert.ok(resolution);
  assert.deepEqual(getOutputDimensions(3840, 2160, resolution), {
    width: 1706,
    height: 960,
  });
});

test("returns no standard downscale presets for invalid or tiny sources", () => {
  assert.deepEqual(getAvailablePresetResolutions(0, 0), []);
  assert.deepEqual(getAvailablePresetResolutions(320, 240), []);
});

test("offers a fresh choice after output-size errors, not processing failures", () => {
  assert.equal(
    isRetryableResolutionError(
      new VideoProcessingError("Too compact", "output_not_smaller"),
    ),
    true,
  );
  assert.equal(
    isRetryableResolutionError(
      new VideoProcessingError("Too large", "output_too_large"),
    ),
    true,
  );
  assert.equal(
    isRetryableResolutionError(
      new VideoProcessingError("Invalid", "invalid_video"),
    ),
    false,
  );
  assert.equal(isRetryableResolutionError(new Error("Unknown")), false);
});
