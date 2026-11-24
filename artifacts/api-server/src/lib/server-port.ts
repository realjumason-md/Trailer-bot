export function parseServerPort(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/u.test(normalized)) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}
