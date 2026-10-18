import assert from "node:assert/strict";
import test from "node:test";
import { compressedVideoFileName } from "./compressed-video-file-name.ts";

test("keeps the source name and uses the compressed MP4 extension", () => {
  assert.equal(
    compressedVideoFileName("holiday clip.mov"),
    "holiday clip.mp4",
  );
  assert.equal(compressedVideoFileName("C:\\videos\\party.MKV"), "party.mp4");
});

test("uses a safe default when no usable source name is present", () => {
  assert.equal(compressedVideoFileName(), "compressed-video.mp4");
  assert.equal(compressedVideoFileName(""), "compressed-video.mp4");
  assert.equal(compressedVideoFileName("../.."), "compressed-video.mp4");
});

test("removes path control and platform-special characters", () => {
  assert.equal(
    compressedVideoFileName("../bad\u0000name:?.mp4"),
    "badname__.mp4",
  );
});

test("limits long filenames without cutting Unicode characters", () => {
  const result = compressedVideoFileName(`${"📹".repeat(130)}.mov`);
  assert.equal(result, `${"📹".repeat(120)}.mp4`);
});
