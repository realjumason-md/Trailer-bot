import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  extractVideoFromZip,
  isZipArchive,
  VideoArchiveError,
} from "./video-archive.ts";

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content);
    const compressionMethod = entry.deflate ? 8 : 0;
    const compressedData = entry.deflate ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, compressedData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressedData.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

async function makeTempDirectory(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "video-archive-test-"),
  );
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("extracts the largest supported video to a fixed output path", async (t) => {
  const directory = await makeTempDirectory(t);
  const archivePath = path.join(directory, "source.zip");
  const outputPath = path.join(directory, "extracted.download");
  const videoBytes = Buffer.from("larger fake video payload");
  await writeFile(
    archivePath,
    createZip([
      { name: "readme.txt", content: "sample archive" },
      { name: "previews/small.mp4", content: "small" },
      { name: "../../media/big_buck_bunny_720p_h264.mov", content: videoBytes },
    ]),
  );

  assert.equal(await isZipArchive(archivePath), true);
  const progress = [];
  const extracted = await extractVideoFromZip(archivePath, outputPath, {
    maxBytes: 1_024,
    signal: new AbortController().signal,
    onProgress: (bytes, totalBytes) => progress.push({ bytes, totalBytes }),
  });

  assert.equal(extracted.fileSize, videoBytes.length);
  assert.equal(extracted.fileName, "big_buck_bunny_720p_h264.mov");
  assert.deepEqual(await readFile(outputPath), videoBytes);
  assert.ok(progress.some((item) => item.bytes === videoBytes.length));
});

test("rejects ZIP archives that contain no supported video", async (t) => {
  const directory = await makeTempDirectory(t);
  const archivePath = path.join(directory, "text-only.zip");
  await writeFile(
    archivePath,
    createZip([{ name: "readme.txt", content: "no video here" }]),
  );

  await assert.rejects(
    extractVideoFromZip(archivePath, path.join(directory, "output"), {
      maxBytes: 1_024,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }),
    (error) => error instanceof VideoArchiveError && error.code === "no-video",
  );
});

test("rejects video entries larger than the configured input limit", async (t) => {
  const directory = await makeTempDirectory(t);
  const archivePath = path.join(directory, "large-video.zip");
  await writeFile(
    archivePath,
    createZip([{ name: "movie.mov", content: "larger than the limit" }]),
  );

  await assert.rejects(
    extractVideoFromZip(archivePath, path.join(directory, "output"), {
      maxBytes: 4,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }),
    (error) => error instanceof VideoArchiveError && error.code === "too-large",
  );
});

test("rejects ZIP entries with an excessive expansion ratio", async (t) => {
  const directory = await makeTempDirectory(t);
  const archivePath = path.join(directory, "compressed-bomb.zip");
  await writeFile(
    archivePath,
    createZip([
      { name: "movie.mov", content: Buffer.alloc(4_096), deflate: true },
    ]),
  );

  await assert.rejects(
    extractVideoFromZip(archivePath, path.join(directory, "output"), {
      maxBytes: 8_192,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }),
    (error) => error instanceof VideoArchiveError && error.code === "too-large",
  );
});
