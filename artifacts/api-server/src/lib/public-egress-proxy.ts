import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  parseDownloadUrl,
  resolvePublicAddress,
  type PublicAddress,
} from "./remote-video-download.ts";

function responseText(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
  response.end(message);
}

async function forwardHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let url: URL;
  let address: PublicAddress;
  try {
    url = parseDownloadUrl(request.url ?? "");
    address = await resolvePublicAddress(url);
  } catch {
    responseText(response, 403, "The download target is not publicly reachable.");
    return;
  }

  const headers = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  headers.host = url.host;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const options = {
    hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    lookup: (
      _hostname: string,
      lookupOptions: { all?: boolean },
      callback: (
        error: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ) => {
      if (lookupOptions.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    },
    ...(url.protocol === "https:" && !hostname.includes(":")
      ? { servername: hostname }
      : {}),
    agent: false as const,
  };

  const upstreamRequest =
    url.protocol === "https:"
      ? httpsRequest(options, (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
          upstreamResponse.pipe(response);
        })
      : httpRequest(options, (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
          upstreamResponse.pipe(response);
        });

  upstreamRequest.on("error", () => {
    if (!response.headersSent) {
      responseText(response, 502, "The public download host could not be reached.");
    } else {
      response.destroy();
    }
  });
  request.on("aborted", () => upstreamRequest.destroy());
  response.on("close", () => {
    if (!response.writableEnded) upstreamRequest.destroy();
  });
  request.pipe(upstreamRequest);
}

function connectResponse(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`,
  );
}

async function forwardConnect(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): Promise<void> {
  let url: URL;
  let address: PublicAddress;
  let port: number;
  try {
    url = parseDownloadUrl(`https://${request.url ?? ""}`);
    port = url.port ? Number(url.port) : 443;
    if (port !== 80 && port !== 443) {
      throw new Error("Unsupported proxy port.");
    }
    address = await resolvePublicAddress(url);
  } catch {
    connectResponse(clientSocket, 403, "Forbidden");
    return;
  }

  const upstream = netConnect({
    host: address.address,
    port,
    family: address.family,
  });
  upstream.setTimeout(60_000, () => upstream.destroy());
  upstream.once("connect", () => {
    upstream.setTimeout(0);
    if (clientSocket.destroyed) {
      upstream.destroy();
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.once("error", () =>
    connectResponse(clientSocket, 502, "Bad Gateway"),
  );
  clientSocket.once("error", () => upstream.destroy());
  clientSocket.once("close", () => upstream.destroy());
}

export type PublicEgressProxy = {
  url: string;
  close: () => Promise<void>;
};

export async function startPublicEgressProxy(): Promise<PublicEgressProxy> {
  const server = createServer((request, response) => {
    void forwardHttpRequest(request, response);
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => {
    void forwardConnect(request, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const boundAddress = server.address();
  if (boundAddress == null || typeof boundAddress === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("The public download proxy did not bind to a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${boundAddress.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
