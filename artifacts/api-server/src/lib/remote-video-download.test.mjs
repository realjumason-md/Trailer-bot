import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadRemoteVideo,
  findHttpUrl,
  isCompletePartialResponse,
  RemoteVideoDownloadError,
} from "./remote-video-download.ts";

function options() {
  return {
    maxBytes: 4 * 1024 * 1024 * 1024,
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

test("accepts only a full-file partial-content response", () => {
  assert.equal(isCompletePartialResponse(200, undefined), false);
  assert.equal(isCompletePartialResponse(206, "bytes 0-999/1000"), true);
  assert.equal(isCompletePartialResponse(206, "bytes 0-499/1000"), false);
  assert.equal(isCompletePartialResponse(206, "bytes 100-999/1000"), false);
  assert.equal(isCompletePartialResponse(206, "bytes */1000"), false);
});

test("finds an HTTP video URL surrounded by text or Markdown", () => {
  assert.equal(
    findHttpUrl("Download this clip: https://cdn.example/video.mp4."),
    "https://cdn.example/video.mp4",
  );
  assert.equal(
    findHttpUrl("[video](https://cdn.example/video.mp4)"),
    "https://cdn.example/video.mp4",
  );
  assert.equal(
    findHttpUrl(
      "No link here, but https://cdn.example/video.mp4 is available.",
    ),
    "https://cdn.example/video.mp4",
  );
});

test("ignores non-web and malformed links when extracting URLs", () => {
  assert.equal(findHttpUrl("file:///tmp/video.mp4"), null);
  assert.equal(findHttpUrl("There is no video link here."), null);
});

test("rejects localhost and private-network download URLs before connecting", async () => {
  for (const url of [
    "http://127.0.0.1/video.mp4",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/video.mp4",
    "https://service.local/video.mp4",
  ]) {
    await assert.rejects(
      downloadRemoteVideo(url, path.join(tmpdir(), randomUUID()), options()),
      (error) =>
        error instanceof RemoteVideoDownloadError &&
        error.message.includes("public internet"),
    );
  }
});

test("rejects non-web and credential-bearing links", async () => {
  for (const url of [
    "file:///etc/passwd",
    "https://user:password@example.com/video.mp4",
    "https://example.com:8443/video.mp4",
  ]) {
    await assert.rejects(
      downloadRemoteVideo(url, path.join(tmpdir(), randomUUID()), options()),
      RemoteVideoDownloadError,
    );
  }
});
