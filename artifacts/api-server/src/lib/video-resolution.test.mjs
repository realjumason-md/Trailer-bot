import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPRESSION_CRF_LEVELS,
  getAvailablePresetResolutions,
  getOutputDimensions,
  getSameResolutionResolution,
  getSmallerPresetResolutions,
  isRetryableResolutionError,
  PRESET_RESOLUTIONS,
  SAME_RESOLUTION_COMPRESSION_CRF_LEVELS,
  VIDEO_ENCODING_PRESET,
  parseCustomResolution,
  VideoProcessingError,
} from "./video-processing.ts";

const presetByLabel = new Map(
  PRESET_RESOLUTIONS.map((resolution) => [resolution.label, resolution]),
);

test("offers the converter-style standard resolution presets", () => {
  assert.equal(presetByLabel.get("144p")?.maxHeight, 144);
  assert.equal(presetByLabel.get("240p")?.maxHeight, 240);
  assert.equal(presetByLabel.get("320p")?.maxHeight, 320);
  assert.equal(presetByLabel.get("360p")?.maxHeight, 360);
  assert.equal(presetByLabel.get("480p")?.maxHeight, 480);
  assert.equal(presetByLabel.get("640p")?.maxHeight, 640);
  assert.equal(presetByLabel.get("960p")?.maxHeight, 960);
  assert.equal(presetByLabel.has("420p"), false);
});

test("offers a same-resolution compression choice", () => {
  const resolution = getSameResolutionResolution(426, 240);
  assert.equal(resolution.label, "Same resolution");
  assert.equal(resolution.preserveSourceDimensions, true);
  assert.deepEqual(getOutputDimensions(426, 240, resolution), {
    width: 426,
    height: 240,
  });
  assert.deepEqual(COMPRESSION_CRF_LEVELS, [27, 31, 35, 38]);
  assert.deepEqual(SAME_RESOLUTION_COMPRESSION_CRF_LEVELS, [27, 31, 35, 38]);
  assert.equal(VIDEO_ENCODING_PRESET, "fast");
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

test("only offers downscale presets, ordered from highest to lowest", () => {
  assert.deepEqual(
    getAvailablePresetResolutions(1280, 720).map(({ label }) => label),
    ["640p", "480p", "360p", "320p", "240p", "144p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(1920, 1080).map(({ label }) => label),
    ["960p", "720p", "640p", "480p", "360p", "320p", "240p", "144p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(3840, 2160).map(({ label }) => label),
    [
      "1440p",
      "1080p",
      "960p",
      "720p",
      "640p",
      "480p",
      "360p",
      "320p",
      "240p",
      "144p",
    ],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(1080, 1920).map(({ label }) => label),
    ["960p", "720p", "640p", "480p", "360p", "320p", "240p", "144p"],
  );
  assert.deepEqual(
    getAvailablePresetResolutions(1728, 720).map(({ label }) => label),
    ["640p", "480p", "360p", "320p", "240p", "144p"],
  );
});

test("finds only presets smaller than the failed resolution", () => {
  assert.deepEqual(
    getSmallerPresetResolutions(1280, 720, presetByLabel.get("480p")).map(
      ({ label }) => label,
    ),
    ["360p", "320p", "240p", "144p"],
  );
  assert.deepEqual(
    getSmallerPresetResolutions(1280, 720, presetByLabel.get("144p")),
    [],
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

test("maps 640p to the correct landscape output dimensions", () => {
  const preset = PRESET_RESOLUTIONS.find(({ label }) => label === "640p");
  assert.ok(preset);
  assert.deepEqual(getOutputDimensions(1280, 720, preset), {
    width: 1136,
    height: 640,
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
  assert.deepEqual(getAvailablePresetResolutions(144, 144), []);
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
