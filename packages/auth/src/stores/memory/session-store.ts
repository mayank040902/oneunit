import type { SessionStore } from "../../types/index.js";

export function createMemorySessionStore(
  options: { revokedSessionTtlMs?: number } = {},
): SessionStore {
  const revokedSessionTtlMs = options.revokedSessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const versions = new Map<string, number>();
  const revoked = new Map<string, number>();

  const cleanRevoked = (): void => {
    const now = Date.now();
    for (const [id, expiresAt] of revoked) {
      if (expiresAt <= now) {
        revoked.delete(id);
      }
    }
  };

  return {
    async getVersion(userId: string | number): Promise<number> {
      return versions.get(String(userId)) ?? 0;
    },
    async bumpVersion(userId: string | number): Promise<number> {
      const next = (versions.get(String(userId)) ?? 0) + 1;
      versions.set(String(userId), next);
      return next;
    },
    async revokeSession(sessionId: string): Promise<void> {
      revoked.set(sessionId, Date.now() + revokedSessionTtlMs);
    },
    async isSessionRevoked(sessionId: string): Promise<boolean> {
      cleanRevoked();
      const expiresAt = revoked.get(sessionId);
      if (expiresAt === undefined) {
        return false;
      }
      if (expiresAt <= Date.now()) {
        revoked.delete(sessionId);
        return false;
      }
      return true;
    },
  };
}
