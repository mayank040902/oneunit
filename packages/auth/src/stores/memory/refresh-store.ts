import type {
  RefreshRecord,
  RefreshStore,
} from "../../types/index.js";

export function createMemoryRefreshStore(): RefreshStore {
  const store = new Map<string, RefreshRecord>();

  const readValid = (id: string): RefreshRecord | null => {
    const record = store.get(id);
    if (!record) {
      return null;
    }
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      store.delete(id);
      return null;
    }
    return record;
  };

  return {
    async save(record) {
      store.set(record.id, record);
    },
    async get(id) {
      return readValid(id);
    },
    // Read and delete without an await in between, so a token cannot be
    // refreshed twice in parallel.
    async consume(id) {
      const record = readValid(id);
      store.delete(id);
      return record;
    },
    async revoke(id) {
      store.delete(id);
    },
  };
}
