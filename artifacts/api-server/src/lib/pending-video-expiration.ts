export function getNextPendingVideoExpiry(
  currentExpiry: number,
  now: number,
  ttlMs: number,
  compressionBusy: boolean,
): number | null {
  if (currentExpiry >= now) return currentExpiry;
  if (compressionBusy) return now + ttlMs;
  return null;
}
