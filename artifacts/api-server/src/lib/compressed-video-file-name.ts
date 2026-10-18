export function compressedVideoFileName(sourceName?: string | null): string {
  const sourceBaseName = (sourceName ?? "").split(/[\\/]/u).pop() ?? "";
  const cleaned = sourceBaseName
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[<>:"|?*]/gu, "_")
    .trim()
    .replace(/[. ]+$/u, "");
  const extensionIndex = cleaned.lastIndexOf(".");
  const stem =
    extensionIndex > 0 ? cleaned.slice(0, extensionIndex) : cleaned;
  const safeStem = Array.from(stem.replace(/^[. ]+/u, "").trim())
    .slice(0, 120)
    .join("")
    .replace(/[. ]+$/u, "");

  return `${safeStem || "compressed-video"}.mp4`;
}
