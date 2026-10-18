export class FifoQueue<T> {
  private readonly entries: T[] = [];
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Queue capacity must be a positive integer.");
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(value: T): boolean {
    if (this.entries.length >= this.capacity) return false;
    this.entries.push(value);
    return true;
  }

  dequeue(): T | undefined {
    return this.entries.shift();
  }

  removeFirst(predicate: (value: T) => boolean): T | undefined {
    const index = this.entries.findIndex(predicate);
    if (index < 0) return undefined;
    return this.entries.splice(index, 1)[0];
  }

  removeWhere(predicate: (value: T) => boolean): T[] {
    const removed: T[] = [];
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const value = this.entries[index];
      if (value !== undefined && predicate(value)) {
        const [entry] = this.entries.splice(index, 1);
        if (entry !== undefined) removed.unshift(entry);
      }
    }
    return removed;
  }

  toArray(): T[] {
    return [...this.entries];
  }

  clear(): T[] {
    return this.entries.splice(0);
  }
}
