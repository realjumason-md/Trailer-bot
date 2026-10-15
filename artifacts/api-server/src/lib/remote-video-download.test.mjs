import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadRemoteVideo,
  RemoteVideoDownloadError,
} from "./remote-video-download.ts";

function options() {
  return {
    maxBytes: 4 * 1024 * 1024 * 1024,
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

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
