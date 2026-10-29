import assert from "node:assert/strict";
import test from "node:test";
import { buildCompressionResultCaption } from "./compression-result-caption.ts";

const baseCaption = "Compressed to 720p · original 40 MB → 8 MB";

test("labels an uploaded video with its original message", () => {
  assert.equal(
    buildCompressionResultCaption(baseCaption),
    `${baseCaption}\nSource: original video message`,
  );
});

test("includes a source URL in the compressed video's caption", () => {
  const sourceUrl = "https://cdn.example/video.mp4?download=1";

  assert.equal(
    buildCompressionResultCaption(baseCaption, sourceUrl),
    `${baseCaption}\nSource link: ${sourceUrl}`,
  );
});

test("uses the replied-to source message for very long links", () => {
  const sourceUrl = `https://cdn.example/${"x".repeat(850)}`;

  assert.equal(
    buildCompressionResultCaption(baseCaption, sourceUrl),
    `${baseCaption}\nSource: original link message`,
  );
});
