const MAX_SOURCE_URL_CAPTION_LENGTH = 800;

export function buildCompressionResultCaption(
  caption: string,
  sourceUrl?: string,
): string {
  const sourceReference =
    sourceUrl == null
      ? "Source: original video message"
      : sourceUrl.length <= MAX_SOURCE_URL_CAPTION_LENGTH
        ? `Source link: ${sourceUrl}`
        : "Source: original link message";

  return `${caption}\n${sourceReference}`;
}
