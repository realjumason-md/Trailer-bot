import assert from "node:assert/strict";
import test from "node:test";
import {
  createDownloadDeadline,
  waitForWithAbort,
} from "./download-deadline.ts";

test("aborts a pending operation when its total deadline expires", async () => {
  const deadline = createDownloadDeadline(new AbortController().signal, 10);
  try {
    await assert.rejects(
      waitForWithAbort(new Promise(() => undefined), deadline.signal),
    );
    assert.equal(deadline.didTimeout(), true);
  } finally {
    deadline.dispose();
  }
});

test("distinguishes caller cancellation from a timeout", async () => {
  const controller = new AbortController();
  const deadline = createDownloadDeadline(controller.signal, 60_000);
  try {
    const operation = waitForWithAbort(
      new Promise(() => undefined),
      deadline.signal,
    );
    controller.abort();
    await assert.rejects(operation);
    assert.equal(deadline.didTimeout(), false);
  } finally {
    deadline.dispose();
  }
});

test("rejects invalid download time limits", () => {
  assert.throws(
    () => createDownloadDeadline(new AbortController().signal, 0),
    RangeError,
  );
  assert.throws(
    () => createDownloadDeadline(new AbortController().signal, Number.NaN),
    RangeError,
  );
});
