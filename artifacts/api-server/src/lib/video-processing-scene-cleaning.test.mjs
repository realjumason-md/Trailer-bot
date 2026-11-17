import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compressVideo } from "./video-processing.ts";

const resolution = {
  label: "360p",
  maxWidth: 7680,
  maxHeight: 360,
  shortSide: 360,
};

async function withFakeMediaTools(options, run) {
  const testDir = await mkdtemp(path.join(tmpdir(), "scene-cleaning-test-"));
  const binDir = path.join(testDir, "bin");
  const inputPath = path.join(testDir, "input.mp4");
  const outputPath = path.join(testDir, "output.mp4");
  const callsPath = path.join(testDir, "ffmpeg-calls.txt");
  const previous = {
    PATH: process.env["PATH"],
    ENABLE_SCENE_CLEANING: process.env["ENABLE_SCENE_CLEANING"],
    SCENE_TEST_CALLS: process.env["SCENE_TEST_CALLS"],
    SCENE_TEST_ARGS: process.env["SCENE_TEST_ARGS"],
    SCENE_TEST_DETECTION: process.env["SCENE_TEST_DETECTION"],
  };

  await mkdir(binDir, { recursive: true });
  await writeFile(inputPath, "source video bytes large enough");
  await writeFile(
    path.join(binDir, "ffprobe"),
    [
      "#!/bin/sh",
      'for arg do if [ "$arg" = "a:0" ]; then printf "0\\n"; exit 0; fi; done',
      'last=""',
      'for arg do last="$arg"; done',
      'duration="10"',
      'case "$last" in *output.mp4) duration="8.3" ;; esac',
      `printf '%s\\n' "{\\"streams\\":[{\\"width\\":1280,\\"height\\":720}],\\"format\\":{\\"duration\\":\\"$duration\\"}}"`,
    ].join("\n"),
  );
  await writeFile(
    path.join(binDir, "ffmpeg"),
    [
      "#!/bin/sh",
      "is_detection=0",
      'previous=""',
      'for arg do if [ "$previous" = "-f" ] && [ "$arg" = "null" ]; then is_detection=1; fi; previous="$arg"; done',
      'if [ "$is_detection" = "1" ]; then',
      '  printf "detect\\n" >> "$SCENE_TEST_CALLS"',
      '  if [ "$SCENE_TEST_DETECTION" = "fail" ]; then echo "simulated detector failure" >&2; exit 1; fi',
      '  echo "[Parsed_freezedetect_0] lavfi.freezedetect.freeze_start: 1.000000" >&2',
      '  echo "[Parsed_freezedetect_0] lavfi.freezedetect.freeze_duration: 1.000000" >&2',
      '  echo "[blackdetect] black_start:4.000000 black_end:4.700000 black_duration:0.700000" >&2',
      "  exit 0",
      "fi",
      'printf "compress\\n" >> "$SCENE_TEST_CALLS"',
      'printf "%s\\n" "$@" >> "$SCENE_TEST_ARGS"',
      'if [ "$SCENE_TEST_DETECTION" = "filtered-fail" ]; then',
      '  for arg do case "$arg" in *select=*) echo "simulated filtered encode failure" >&2; exit 1 ;; esac; done',
      "fi",
      'last=""',
      'for arg do last="$arg"; done',
      'printf "ok" > "$last"',
    ].join("\n"),
  );
  await chmod(path.join(binDir, "ffprobe"), 0o700);
  await chmod(path.join(binDir, "ffmpeg"), 0o700);
  process.env["PATH"] = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
  process.env["SCENE_TEST_CALLS"] = callsPath;
  process.env["SCENE_TEST_ARGS"] = path.join(testDir, "ffmpeg-args.txt");
  process.env["SCENE_TEST_DETECTION"] = options.detection ?? "success";
  if (options.enabled) process.env["ENABLE_SCENE_CLEANING"] = "true";
  else delete process.env["ENABLE_SCENE_CLEANING"];

  try {
    const result = await compressVideo({
      inputPath,
      outputPath,
      resolution,
      onProcess: () => undefined,
      onVideoInfo: () => undefined,
      onProgress: () => undefined,
    });
    const calls = await readFile(callsPath, "utf8");
    const args = await readFile(process.env["SCENE_TEST_ARGS"], "utf8");
    await run({ result, calls, args, outputPath });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(testDir, { recursive: true, force: true });
  }
}

test("keeps scene detection out of the default compression path", async () => {
  await withFakeMediaTools({}, async ({ result, calls }) => {
    assert.equal(result.removedSceneSeconds, undefined);
    assert.equal(calls, "compress\n");
  });
});

test("applies safe detected cuts only when explicitly enabled", async () => {
  await withFakeMediaTools(
    { enabled: true },
    async ({ result, calls, args }) => {
      assert.ok(Math.abs(result.removedSceneSeconds - 1.7) < 0.000001);
      assert.match(calls, /^detect\ncompress\n$/u);
      assert.match(args, /select='not\(/u);
      assert.match(args, /aselect='not\(/u);
    },
  );
});

test("falls back to the original encode when scene detection fails", async () => {
  await withFakeMediaTools(
    { enabled: true, detection: "fail" },
    async ({ result, calls }) => {
      assert.equal(result.removedSceneSeconds, undefined);
      assert.match(calls, /^detect\ncompress\n$/u);
    },
  );
});

test("falls back to the original encode when filtered encoding fails", async () => {
  await withFakeMediaTools(
    { enabled: true, detection: "filtered-fail" },
    async ({ result, calls }) => {
      assert.equal(result.removedSceneSeconds, undefined);
      assert.match(calls, /^detect\ncompress\ncompress\n$/u);
    },
  );
});
