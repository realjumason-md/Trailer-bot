import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadRemoteVideo,
  findHttpUrl,
  isCompletePartialResponse,
  getDownloadByteLimitForSignature,
  hasZipArchiveSignature,
  isZipArchiveFile,
  isZipArchiveUrl,
  RemoteVideoDownloadError,
} from "./remote-video-download.ts";

function options() {
  return {
    maxBytes: 10_000_000_000,
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

test("recognizes ZIP archive links, including query strings and trailing slashes", () => {
  assert.equal(
    isZipArchiveUrl("https://cdn.example/clip.ZIP?token=private"),
    true,
  );
  assert.equal(isZipArchiveUrl("https://cdn.example/clip.zip/"), true);
  assert.equal(isZipArchiveUrl("https://cdn.example/clip.zip.mp4"), false);
  assert.equal(isZipArchiveUrl("https://cdn.example/clip.mp4"), false);
  assert.equal(isZipArchiveUrl("file:///tmp/clip.zip"), false);
});

test("recognizes standard ZIP signatures without extracting the archive", () => {
  for (const signature of [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
  ]) {
    assert.equal(hasZipArchiveSignature(Uint8Array.from(signature)), true);
  }
  assert.equal(
    hasZipArchiveSignature(Uint8Array.from([0x50, 0x4b, 0x00, 0x00])),
    false,
  );
  assert.equal(
    hasZipArchiveSignature(Uint8Array.from([0x50, 0x4b, 0x03])),
    false,
  );
  assert.equal(hasZipArchiveSignature(new TextEncoder().encode("ftyp")), false);
});

test("applies the ZIP byte limit when the download signature is recognized", () => {
  const maxVideoBytes = 5_000_000_000;
  const maxZipBytes = 1_900_000_000;
  assert.equal(
    getDownloadByteLimitForSignature(
      Uint8Array.from([0x50, 0x4b, 0x03]),
      maxVideoBytes,
      maxZipBytes,
    ),
    maxVideoBytes,
  );
  assert.equal(
    getDownloadByteLimitForSignature(
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      maxVideoBytes,
      maxZipBytes,
    ),
    maxZipBytes,
  );
  assert.equal(
    getDownloadByteLimitForSignature(
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      maxZipBytes,
      maxVideoBytes,
    ),
    maxZipBytes,
  );
});

test("detects downloaded ZIP files by reading their file signature", async () => {
  const archivePath = path.join(tmpdir(), `${randomUUID()}.zip`);
  try {
    await writeFile(
      archivePath,
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03]),
    );
    assert.equal(await isZipArchiveFile(archivePath), true);
    await writeFile(archivePath, "not a ZIP archive");
    assert.equal(await isZipArchiveFile(archivePath), false);
  } finally {
    await unlink(archivePath).catch(() => undefined);
  }
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
