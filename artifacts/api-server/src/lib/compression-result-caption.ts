const MAX_SOURCE_URL_CAPTION_LENGTH = 800;

export function buildCompressionResultCaption(
  caption: string,
  sourceUrl?: string,
  removedSceneSeconds?: number,
): string {
  const sourceReference =
    sourceUrl == null
      ? "Source: original video message"
      : sourceUrl.length <= MAX_SOURCE_URL_CAPTION_LENGTH
        ? `Source link: ${sourceUrl}`
        : "Source: original link message";

  const cleaningNote =
    removedSceneSeconds != null &&
    Number.isFinite(removedSceneSeconds) &&
    removedSceneSeconds > 0
      ? `Removed ${removedSceneSeconds.toFixed(1)} seconds of frozen/blank scenes`
      : null;

  return [caption, cleaningNote, sourceReference].filter(Boolean).join("\n");
}
