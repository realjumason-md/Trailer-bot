import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { startPublicEgressProxy } from "./public-egress-proxy.ts";

function requestThroughProxy(proxyUrl, targetUrl) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: targetUrl,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("blocks private targets before opening an upstream connection", async () => {
  const proxy = await startPublicEgressProxy();
  try {
    assert.equal(
      await requestThroughProxy(proxy.url, "http://127.0.0.1/internal"),
      403,
    );
  } finally {
    await proxy.close();
  }
});
