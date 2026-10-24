import type { StateStore } from "../../types/index.js";

export function createMemoryStateStore(): StateStore {
  const store = new Map<string, { value: unknown; expiresAt: number }>();

  return {
    async set(key, value, ttlSeconds = 600) {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async delete(key) {
      store.delete(key);
    },
    async consume(key) {
      const record = await this.get(key);
      store.delete(key);
      return record;
    },
  };
}
