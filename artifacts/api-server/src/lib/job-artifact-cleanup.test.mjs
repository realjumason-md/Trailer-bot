import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  JOB_ARTIFACT_MIN_AGE_MS,
  removeStaleJobArtifacts,
} from "./job-artifact-cleanup.ts";

test("removes stale untracked artifacts but preserves recent and active jobs", async () => {
  const jobsDirectory = await mkdtemp(path.join(tmpdir(), "job-cleanup-test-"));
  const now = Date.now();
  const oldFile = path.join(jobsDirectory, "old.download");
  const recentFile = path.join(jobsDirectory, "recent.download");
  const activeDirectory = path.join(jobsDirectory, "active-job");
  const activeOutput = path.join(activeDirectory, "output.mp4");
  const staleDate = new Date(now - JOB_ARTIFACT_MIN_AGE_MS - 1);

  await writeFile(oldFile, "old");
  await writeFile(recentFile, "recent");
  await mkdir(activeDirectory);
  await writeFile(activeOutput, "active");
  await utimes(oldFile, staleDate, staleDate);
  await utimes(activeDirectory, staleDate, staleDate);

  try {
    const removed = await removeStaleJobArtifacts(
      jobsDirectory,
      [activeOutput],
      now,
    );

    assert.equal(removed, 1);
    await assert.rejects(lstat(oldFile), { code: "ENOENT" });
    await lstat(recentFile);
    await lstat(activeOutput);
  } finally {
    await rm(jobsDirectory, { recursive: true, force: true });
  }
});

test("treats a missing jobs directory as an empty directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "job-cleanup-missing-"));
  try {
    assert.equal(
      await removeStaleJobArtifacts(path.join(parent, "jobs"), [], Date.now()),
      0,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
