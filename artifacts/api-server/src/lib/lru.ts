// A bounded map, in about thirty lines and with no dependency.
//
// Every per-account cache in a multi-tenant process is a slow memory leak
// unless something evicts: the config primed for each request
// (lib/config.ts), the resolved AI provider (lib/ai/provider.ts), the cover
// letter template (lib/sources/tailoring.ts). Each one is small, and each one
// grows with the number of accounts that have ever been served since boot.
//
// Insertion order is the recency order: a `get` that hits re-inserts the key
// at the end, so the first key of the iterator is always the least recently
// used one. That is exactly what a JS Map already guarantees, which is why
// this needs no linked list.

export class BoundedCache<K, V> {
  readonly capacity: number;
  #entries = new Map<K, V>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`BoundedCache needs a positive integer capacity, got ${String(capacity)}`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert so this key becomes the most recently used one.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  keys(): K[] {
    return Array.from(this.#entries.keys());
  }
}
