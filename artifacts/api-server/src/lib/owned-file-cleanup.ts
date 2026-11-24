import { unlink } from "node:fs/promises";
import path from "node:path";

export async function removeOwnedFile(
  filePath: string,
  ownedRoots: readonly string[],
): Promise<void> {
  const resolvedFile = path.resolve(filePath);
  const isOwned = ownedRoots.some((root) =>
    resolvedFile.startsWith(`${path.resolve(root)}${path.sep}`),
  );
  if (!isOwned) return;

  await unlink(resolvedFile).catch(() => undefined);
}
