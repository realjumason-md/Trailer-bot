import assert from "node:assert/strict";
import test from "node:test";
import { FifoQueue } from "./fifo-queue.ts";

test("limits queue length and preserves FIFO order", () => {
  const queue = new FifoQueue(2);
  assert.equal(queue.enqueue("first"), true);
  assert.equal(queue.enqueue("second"), true);
  assert.equal(queue.enqueue("third"), false);
  assert.equal(queue.dequeue(), "first");
  assert.equal(queue.enqueue("third"), true);
  assert.deepEqual(queue.toArray(), ["second", "third"]);
});

test("removes the next matching job without disturbing other users", () => {
  const queue = new FifoQueue(3);
  queue.enqueue({ owner: "one", id: 1 });
  queue.enqueue({ owner: "two", id: 2 });
  queue.enqueue({ owner: "one", id: 3 });
  assert.deepEqual(
    queue.removeFirst((job) => job.owner === "one"),
    { owner: "one", id: 1 },
  );
  assert.deepEqual(
    queue.removeWhere((job) => job.owner === "one"),
    [{ owner: "one", id: 3 }],
  );
  assert.deepEqual(queue.toArray(), [{ owner: "two", id: 2 }]);
});

test("rejects an invalid capacity", () => {
  assert.throws(() => new FifoQueue(0), RangeError);
});
