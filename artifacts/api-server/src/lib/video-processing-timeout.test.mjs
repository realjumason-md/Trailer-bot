import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compressVideo } from "./video-processing.ts";

test("stops FFmpeg when the overall processing deadline expires", async () => {
  const testDir = await mkdtemp(path.join(tmpdir(), "video-timeout-test-"));
  const binDir = path.join(testDir, "bin");
  const inputPath = path.join(testDir, "input.mp4");
  const outputPath = path.join(testDir, "output.mp4");
  const previousPath = process.env["PATH"];
  await mkdir(binDir, { recursive: true });
  await writeFile(inputPath, "test input");
  await writeFile(
    path.join(binDir, "ffprobe"),
    `#!/bin/sh\nprintf '%s\\n' '{"streams":[{"width":1280,"height":720}],"format":{"duration":"1"}}'\n`,
  );
  await writeFile(
    path.join(binDir, "ffmpeg"),
    "#!/bin/sh\nexec /bin/sleep 10\n",
  );
  await chmod(path.join(binDir, "ffprobe"), 0o700);
  await chmod(path.join(binDir, "ffmpeg"), 0o700);
  process.env["PATH"] = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  try {
    await assert.rejects(
      compressVideo({
        inputPath,
        outputPath,
        resolution: {
          label: "360p",
          maxWidth: 7680,
          maxHeight: 360,
          shortSide: 360,
        },
        onProcess: () => undefined,
        onVideoInfo: () => undefined,
        onProgress: () => undefined,
        maxProcessingTimeMs: 500,
      }),
      (error) => error?.code === "timeout",
    );
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    await rm(testDir, { recursive: true, force: true });
  }
});
