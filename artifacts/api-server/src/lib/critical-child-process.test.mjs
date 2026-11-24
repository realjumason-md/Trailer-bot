import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { watchCriticalChildProcessFailure } from "./critical-child-process.ts";

test("reports an unexpected critical child exit", () => {
  const child = new EventEmitter();
  const failures = [];
  watchCriticalChildProcessFailure(
    child,
    () => false,
    (failure) => {
      failures.push(failure);
    },
  );

  child.emit("exit", 3, null);

  assert.deepEqual(failures, [{ type: "exit", code: 3, signal: null }]);
});

test("reports a critical child spawn error", () => {
  const child = new EventEmitter();
  const error = new Error("spawn failed");
  const failures = [];
  watchCriticalChildProcessFailure(
    child,
    () => false,
    (failure) => {
      failures.push(failure);
    },
  );

  child.emit("error", error);

  assert.deepEqual(failures, [{ type: "error", error }]);
});

test("ignores critical child failures during shutdown", () => {
  const child = new EventEmitter();
  const failures = [];
  watchCriticalChildProcessFailure(
    child,
    () => true,
    (failure) => {
      failures.push(failure);
    },
  );

  child.emit("error", new Error("expected during shutdown"));
  child.emit("exit", null, "SIGTERM");

  assert.deepEqual(failures, []);
});
