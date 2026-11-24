import assert from "node:assert/strict";
import test from "node:test";
import { parseServerPort } from "./server-port.ts";

test("accepts a valid server port", () => {
  assert.equal(parseServerPort("8080"), 8080);
  assert.equal(parseServerPort(" 443 "), 443);
});

test("rejects missing, fractional, and out-of-range ports", () => {
  for (const value of [undefined, "", "1.5", "0", "65536", "port"]) {
    assert.throws(() => parseServerPort(value), /PORT must be an integer/u);
  }
});
