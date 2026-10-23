import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { request as httpsRequest } from "node:https";

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

export function isCompletePartialResponse(
  statusCode: number | undefined,
  contentRange: string | undefined,
): boolean {
  if (statusCode !== 206 || !contentRange) return false;
  const match = contentRange.match(/^bytes\s+0-(\d+)\/(\d+)$/i);
  return Boolean(
    match &&
      Number(match[1]) + 1 === Number(match[2]) &&
      Number(match[2]) > 0,
  );
}

export class RemoteVideoDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteVideoDownloadError";
  }
}

type DownloadProgress = {
  downloadedBytes: number;
  totalBytes?: number;
};

type PublicAddress = {
  address: string;
  family: number;
};

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

function ipv4InCidr(address: number, network: string, prefix: number): boolean {
  const networkNumber = ipv4Number(network);
  if (networkNumber == null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (networkNumber & mask);
}

function isPublicIpv4(address: string): boolean {
  const number = ipv4Number(address);
  if (number == null) return false;
  const nonPublicRanges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !nonPublicRanges.some(([network, prefix]) =>
    ipv4InCidr(number, network, prefix),
  );
}

function ipv6Number(address: string): bigint | null {
  if (isIP(address) !== 6 || address.includes("%")) return null;
  const normalized = address.toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (half: string): string[] => (half ? half.split(":") : []);
  let left = parseHalf(halves[0] ?? "");
  let right = parseHalf(halves[1] ?? "");

  const expandIpv4Tail = (parts: string[]): string[] | null => {
    const last = parts.at(-1);
    if (!last?.includes(".")) return parts;
    const number = ipv4Number(last);
    if (number == null) return null;
    return [
      ...parts.slice(0, -1),
      ((number >>> 16) & 0xffff).toString(16),
      (number & 0xffff).toString(16),
    ];
  };
  const expandedLeft = expandIpv4Tail(left);
  const expandedRight = expandIpv4Tail(right);
  if (!expandedLeft || !expandedRight) return null;
  left = expandedLeft;
  right = expandedRight;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;

  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group || "0"}`),
    0n,
  );
}

function ipv6InCidr(address: bigint, network: string, prefix: number): boolean {
  const networkNumber = ipv6Number(network);
  if (networkNumber == null) return false;
  const shift = BigInt(128 - prefix);
  return address >> shift === networkNumber >> shift;
}

function isPublicIpv6(address: string): boolean {
  const number = ipv6Number(address);
  if (number == null) return false;
  // Accept global-unicast space only; this excludes loopback, private, link-local,
  // multicast, mapped IPv4, and special-use addresses by default.
  if (!ipv6InCidr(number, "2000::", 3)) return false;
  const nonPublicRanges: Array<[string, number]> = [
    ["2001:db8::", 32],
    ["2001:10::", 28],
    ["2001::", 23],
    ["2002::", 16],
  ];
  return !nonPublicRanges.some(([network, prefix]) =>
    ipv6InCidr(number, network, prefix),
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function parseDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteVideoDownloadError(
      "That link is not a valid web address. Send a direct video download link instead.",
    );
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port && url.port !== "80" && url.port !== "443")
  ) {
    throw new RemoteVideoDownloadError(
      "For safety, use a public HTTP or HTTPS video download link without a custom port or sign-in credentials.",
    );
  }
  url.hash = "";
  return url;
}

async function resolvePublicAddress(url: URL): Promise<PublicAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new RemoteVideoDownloadError(
      "That link does not point to a public internet address.",
    );
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicAddress(hostname)) {
      throw new RemoteVideoDownloadError(
        "That link does not point to a public internet address.",
      );
    }
    return { address: hostname, family: literalFamily };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new RemoteVideoDownloadError(
      "I couldn't find that download link. Check it and try again.",
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicAddress(entry.address))
  ) {
    throw new RemoteVideoDownloadError(
      "That link does not resolve only to public internet addresses.",
    );
  }
  const address = addresses[0];
  if (!address) {
    throw new RemoteVideoDownloadError(
      "I couldn't find that download link. Check it and try again.",
    );
  }
  return address;
}

function requestRemoteFile(
  url: URL,
  address: PublicAddress,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RemoteVideoDownloadError("Download cancelled."));
      return;
    }

    const pinnedLookup = (
      _hostname: string,
      options: { all?: boolean },
      callback: (
        error: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ): void => {
      if (options.all) {
        callback(null, [{ address: address.address, family: address.family }]);
      } else {
        callback(null, address.address, address.family);
      }
    };
    const requestOptions = {
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        accept: "video/*, application/octet-stream;q=0.9, */*;q=0.1",
        "accept-encoding": "identity",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        referer: `${url.origin}/`,
      },
      lookup: pinnedLookup,
      servername: url.protocol === "https:" ? url.hostname : undefined,
    };
    const request =
      url.protocol === "https:"
        ? httpsRequest(requestOptions, resolve)
        : httpRequest(requestOptions, resolve);

    const onAbort = (): void => {
      request.destroy(new RemoteVideoDownloadError("Download cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => signal.removeEventListener("abort", onAbort));
    request.once("error", (error: Error) => {
      signal.removeEventListener("abort", onAbort);
      reject(
        error instanceof RemoteVideoDownloadError
          ? error
          : new RemoteVideoDownloadError(
              "The download link could not be reached. Check the link and try again.",
            ),
      );
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new RemoteVideoDownloadError(
          "The download server took too long to respond.",
        ),
      );
    });
    request.end();
  });
}

async function downloadRedirects(
  url: URL,
  destination: string,
  maxBytes: number,
  signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
  redirectsRemaining: number,
): Promise<number> {
  const address = await resolvePublicAddress(url);
  const response = await requestRemoteFile(url, address, signal);

  if (
    response.statusCode &&
    response.statusCode >= 300 &&
    response.statusCode < 400
  ) {
    const location = response.headers.location;
    response.destroy();
    if (!location || redirectsRemaining <= 0) {
      throw new RemoteVideoDownloadError(
        "The download link redirected too many times or had an invalid redirect.",
      );
    }
    return downloadRedirects(
      parseDownloadUrl(new URL(location, url).toString()),
      destination,
      maxBytes,
      signal,
      onProgress,
      redirectsRemaining - 1,
    );
  }

  const completePartialResponse = isCompletePartialResponse(
    response.statusCode,
    response.headers["content-range"],
  );
  if (response.statusCode !== 200 && !completePartialResponse) {
    const status = response.statusCode ?? "unknown";
    response.destroy();
    throw new RemoteVideoDownloadError(
      `The video host returned HTTP ${status} instead of a complete video file. Check that the link is public and try copying the direct download link again.`,
    );
  }

  const contentType = response.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType &&
    (contentType.startsWith("text/") ||
      contentType.includes("json") ||
      contentType.includes("xml") ||
      contentType.includes("html") ||
      contentType.includes("mpegurl"))
  ) {
    response.destroy();
    throw new RemoteVideoDownloadError(
      "That link opens a webpage, not a direct video download. Paste a direct link to the video file.",
    );
  }

  const declaredSize = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    response.destroy();
    throw new RemoteVideoDownloadError("This bot accepts videos up to 4 GB.");
  }
  const totalBytes =
    Number.isFinite(declaredSize) && declaredSize >= 0
      ? declaredSize
      : completePartialResponse
        ? Number(response.headers["content-range"]?.match(/\/(\d+)$/)?.[1])
      : undefined;
  let downloadedBytes = 0;
  let initialBytes = Buffer.alloc(0);
  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > maxBytes) {
        callback(
          new RemoteVideoDownloadError("This bot accepts videos up to 4 GB."),
        );
        return;
      }
      if (initialBytes.length < 1_024) {
        initialBytes = Buffer.concat([
          initialBytes,
          chunk.subarray(0, 1_024 - initialBytes.length),
        ]);
        const signature = initialBytes
          .toString("utf8")
          .replace(/^\uFEFF/, "")
          .trimStart()
          .toLowerCase();
        if (
          signature.startsWith("#extm3u") ||
          /<mpd(?:\s|>)/i.test(signature)
        ) {
          callback(
            new RemoteVideoDownloadError(
              "That link is a streaming playlist, not a direct video file. Paste a direct download link instead.",
            ),
          );
          return;
        }
      }
      onProgress({
        downloadedBytes,
        ...(totalBytes != null ? { totalBytes } : {}),
      });
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      response,
      progressStream,
      createWriteStream(destination, { flags: "wx" }),
      { signal },
    );
    if (downloadedBytes === 0) {
      throw new RemoteVideoDownloadError(
        "The download link returned an empty file.",
      );
    }
    if (completePartialResponse && totalBytes !== downloadedBytes) {
      throw new RemoteVideoDownloadError(
        "The video host returned an incomplete video file. Please try the link again.",
      );
    }
    return downloadedBytes;
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    if (signal.aborted) {
      throw new RemoteVideoDownloadError("Download cancelled.");
    }
    if (error instanceof RemoteVideoDownloadError) throw error;
    throw new RemoteVideoDownloadError(
      "The download was interrupted. Check the link and try again.",
    );
  }
}

export async function downloadRemoteVideo(
  value: string,
  destination: string,
  options: {
    maxBytes: number;
    signal: AbortSignal;
    onProgress: (progress: DownloadProgress) => void;
  },
): Promise<number> {
  try {
    return await downloadRedirects(
      parseDownloadUrl(value),
      destination,
      options.maxBytes,
      options.signal,
      options.onProgress,
      MAX_REDIRECTS,
    );
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    if (error instanceof RemoteVideoDownloadError) throw error;
    if (options.signal.aborted) {
      throw new RemoteVideoDownloadError("Download cancelled.");
    }
    throw new RemoteVideoDownloadError(
      "The video could not be downloaded from that link.",
    );
  }
}
