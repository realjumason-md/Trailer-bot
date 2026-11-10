import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const JOB_ARTIFACT_MIN_AGE_MS = 2 * 60 * 60 * 1_000;

/**
 * Removes old top-level job artifacts unless they contain a path tracked by
 * the current process. This directory is separate from Telegram's API storage.
 */
export async function removeStaleJobArtifacts(
  jobsDirectory: string,
  trackedPaths: Iterable<string>,
  now = Date.now(),
  minAgeMs = JOB_ARTIFACT_MIN_AGE_MS,
): Promise<number> {
  const protectedPaths = [...trackedPaths].map((filePath) =>
    path.resolve(filePath),
  );
  const directoryMetadata = await lstat(jobsDirectory).catch(
    (error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    },
  );
  if (!directoryMetadata) return 0;
  if (!directoryMetadata.isDirectory()) {
    throw new Error("Job artifact cleanup path is not a directory");
  }

  const entries = await readdir(jobsDirectory, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    const artifactPath = path.resolve(jobsDirectory, entry.name);
    const containsTrackedPath = protectedPaths.some(
      (trackedPath) =>
        trackedPath === artifactPath ||
        trackedPath.startsWith(`${artifactPath}${path.sep}`),
    );
    if (containsTrackedPath) continue;

    const metadata = await lstat(artifactPath).catch(() => null);
    if (!metadata || now - metadata.mtimeMs < minAgeMs) continue;

    await rm(artifactPath, { recursive: true, force: true });
    removed += 1;
  }

  return removed;
}
