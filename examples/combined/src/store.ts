import { randomUUID } from "node:crypto";
import type { UserRecord, UserStore } from "@oneunit/auth";

interface MemoryUser extends UserRecord {
  passwordHash?: string;
}

export function createMemoryUserStore(): UserStore & { users: Map<string, MemoryUser> } {
  const users = new Map<string, MemoryUser>();

  const store: UserStore & { users: Map<string, MemoryUser> } = {
    users,

    async findById(id) {
      return users.get(String(id)) ?? null;
    },

    async findByEmail(email) {
      return [...users.values()].find((user) => user.email === email) ?? null;
    },

    async findByCredentials(identifier) {
      return store.findByEmail?.(identifier) ?? null;
    },

    async create(input) {
      const id = randomUUID();
      const roles = Array.isArray(input.roles) ? input.roles as string[] : ["member"];
      // Optional fields are omitted rather than set to `undefined`. Under
      // exactOptionalPropertyTypes, `email?: string` does not accept
      // `email: string | undefined`, so assigning the key unconditionally is a
      // type error and is also not the same value at runtime: the key ends up
      // present with an undefined value, which serialises differently and can
      // surprise code that checks `"email" in user`.
      const user: MemoryUser = {
        id,
        roles,
        ...(typeof input.email === "string" && { email: input.email }),
        ...(typeof input.username === "string" && { username: input.username }),
        ...(typeof input.name === "string" && { name: input.name }),
        ...(typeof input.passwordHash === "string" && { passwordHash: input.passwordHash }),
      };
      users.set(id, user);
      return user;
    },

    async updatePassword(id, passwordHash) {
      const user = users.get(String(id));
      if (user) {
        user.passwordHash = passwordHash;
      }
    },
  };

  return store;
}

export function createDatabaseUserStore(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  queryOne: (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>;
}): UserStore {
  function mapRow(row: Record<string, unknown> | null): UserRecord | null {
    if (!row) {
      return null;
    }
    const roles = typeof row.roles === "string"
      ? row.roles.split(",").map((role) => role.trim()).filter(Boolean)
      : Array.isArray(row.roles)
        ? row.roles as string[]
        : ["member"];
    return {
      id: row.id as string,
      roles,
      ...(typeof row.email === "string" && { email: row.email }),
      ...(typeof row.password_hash === "string" && { passwordHash: row.password_hash }),
    };
  }

  return {
    async findById(id) {
      const row = await db.queryOne("SELECT id, email, roles, password_hash FROM users WHERE id = $1", [id]);
      return mapRow(row);
    },

    async findByEmail(email) {
      const row = await db.queryOne("SELECT id, email, roles, password_hash FROM users WHERE email = $1", [email]);
      return mapRow(row);
    },

    async findByCredentials(identifier) {
      const row = await db.queryOne("SELECT id, email, roles, password_hash FROM users WHERE email = $1", [identifier]);
      return mapRow(row);
    },

    async create(input) {
      const id = randomUUID();
      const roles = Array.isArray(input.roles) ? (input.roles as string[]).join(",") : "member";
      const row = await db.queryOne(
        `INSERT INTO users (id, email, password_hash, roles)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, roles, password_hash`,
        [id, input.email, input.passwordHash, roles],
      );
      return mapRow(row) as UserRecord;
    },

    async updatePassword(id, passwordHash) {
      await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, id]);
    },
  };
}

export async function ensureUsersTable(db: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      roles TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
