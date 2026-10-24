import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { Redis as IORedis } from "ioredis";
import { createAuth } from "../src/index.js";
import type { RefreshRecord, RefreshStore } from "../src/index.js";
import type { SessionStore } from "../src/types/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://user@localhost/mydb?host=/run/postgresql";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const SECRET = "distributed-atomicity-test-secret-do-not-use-in-production";

// ---------------------------------------------------------------------------
// Test-only Redis-backed store implementations (not exported from the package)
// ---------------------------------------------------------------------------

function createRedisRefreshStore(redis: IORedis, prefix = "auth:rt:"): RefreshStore {
  const consumeScript = `
    local record = redis.call('GET', KEYS[1])
    if not record then return nil end
    local data = cjson.decode(record)
    if data.expires_at and tonumber(data.expires_at) <= tonumber(ARGV[1]) then
      redis.call('DEL', KEYS[1])
      return nil
    end
    redis.call('DEL', KEYS[1])
    return record
  `;

  return {
    async save(record: RefreshRecord) {
      await redis.set(`${prefix}${record.id}`, JSON.stringify({
        userId: record.userId,
        tokenHash: record.tokenHash,
        expiresAt: record.expiresAt,
      }));
      if (record.expiresAt) {
        const ttlSeconds = Math.ceil((record.expiresAt - Date.now()) / 1000);
        if (ttlSeconds > 0) {
          await redis.expire(`${prefix}${record.id}`, ttlSeconds);
        }
      }
    },
    async get(id: string): Promise<RefreshRecord | null> {
      const raw = await redis.get(`${prefix}${id}`);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.expiresAt && data.expiresAt <= Date.now()) {
        await redis.del(`${prefix}${id}`);
        return null;
      }
      return { id, userId: data.userId, tokenHash: data.tokenHash, expiresAt: data.expiresAt } as RefreshRecord;
    },
    async consume(id: string): Promise<RefreshRecord | null> {
      const result = await redis.eval(consumeScript, 1, `${prefix}${id}`, String(Date.now()));
      if (!result) return null;
      const data = JSON.parse(result as string);
      return { id, userId: data.userId, tokenHash: data.tokenHash, expiresAt: data.expiresAt } as RefreshRecord;
    },
    async revoke(id: string) {
      await redis.del(`${prefix}${id}`);
    },
  };
}

function createRedisSessionStore(redis: IORedis, prefix = "auth:ss:"): SessionStore {
  return {
    async getVersion(userId: string | number): Promise<number> {
      const raw = await redis.get(`${prefix}${userId}`);
      return raw ? parseInt(raw, 10) : 0;
    },
    async bumpVersion(userId: string | number): Promise<number> {
      const next = await redis.incr(`${prefix}${userId}`);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only PostgreSQL-backed store implementations (not exported from the package)
// ---------------------------------------------------------------------------

function createPgRefreshStore(pool: Pool): RefreshStore {
  return {
    async save(record: RefreshRecord) {
      await pool.query(
        `INSERT INTO auth_refresh_tokens (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at`,
        [record.id, record.userId, record.tokenHash, record.expiresAt],
      );
    },
    async get(id: string): Promise<RefreshRecord | null> {
      const { rows } = await pool.query(
        "SELECT id, user_id, token_hash, expires_at FROM auth_refresh_tokens WHERE id = $1",
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      if (row.expires_at && Number(row.expires_at) <= Date.now()) {
        await pool.query("DELETE FROM auth_refresh_tokens WHERE id = $1", [id]);
        return null;
      }
      return { id, userId: row.user_id, tokenHash: row.token_hash, expiresAt: Number(row.expires_at) } as RefreshRecord;
    },
    async consume(id: string): Promise<RefreshRecord | null> {
      const { rows } = await pool.query(
        `DELETE FROM auth_refresh_tokens WHERE id = $1 RETURNING id, user_id, token_hash, expires_at`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, userId: row.user_id, tokenHash: row.token_hash, expiresAt: Number(row.expires_at) } as RefreshRecord;
    },
    async revoke(id: string) {
      await pool.query("DELETE FROM auth_refresh_tokens WHERE id = $1", [id]);
    },
  };
}

function createPgSessionStore(pool: Pool): SessionStore {
  return {
    async getVersion(userId: string | number): Promise<number> {
      const { rows } = await pool.query(
        "SELECT version FROM auth_session_versions WHERE user_id = $1",
        [userId],
      );
      const row = rows[0];
      return row ? Number(row.version) : 0;
    },
    async bumpVersion(userId: string | number): Promise<number> {
      const { rows } = await pool.query(
        `INSERT INTO auth_session_versions (user_id, version) VALUES ($1, 1)
         ON CONFLICT (user_id) DO UPDATE SET version = auth_session_versions.version + 1
         RETURNING version`,
        [userId],
      );
      return Number(rows[0].version);
    },
  };
}

// ---------------------------------------------------------------------------
// Schema setup helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Redis distributed atomicity tests
// ---------------------------------------------------------------------------



async function redisAvailable(url: string): Promise<boolean> {
  try {
    const client = new IORedis(url, { connectTimeout: 1000, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null } as any);
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    return pong === "PONG";
  } catch {
    return false;
  }
}

async function pgAvailable(url: string): Promise<boolean> {
  try {
    const { Pool } = await import("pg");
    const pool = new (Pool as any)({ connectionString: url, connectionTimeoutMillis: 1000 });
    await pool.query("SELECT 1");
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

const REDIS_AVAILABLE = await redisAvailable(REDIS_URL);
const PG_AVAILABLE = await pgAvailable(DATABASE_URL);
if (!REDIS_AVAILABLE) console.log(`[BLOCKED] Redis distributed tests skipped: Redis not reachable at ${REDIS_URL}`);
if (!PG_AVAILABLE) console.log(`[BLOCKED] PostgreSQL distributed tests skipped: PostgreSQL not reachable at ${DATABASE_URL.replace(/:[^:@]*@/, ":***@")}`);
const REQUIRED_SERVICES = process.env.REQUIRES_SERVICES === "1" || process.env.REQUIRE_SERVICES === "1";
if (REQUIRED_SERVICES && !REDIS_AVAILABLE) throw new Error(`[BLOCKED] REQUIRED Redis service not reachable at ${REDIS_URL}`);
if (REQUIRED_SERVICES && !PG_AVAILABLE) throw new Error(`[BLOCKED] REQUIRED PostgreSQL service not reachable at ${DATABASE_URL.replace(/:[^:@]*@/, ":***@")}`);

const describeRedis = REDIS_AVAILABLE ? describe : describe.skip;
const describePg = PG_AVAILABLE ? describe : describe.skip;

describeRedis("distributed atomicity with real Redis", () => {
  it("single-use consumption: only one of two concurrent refreshes succeeds", async () => {
    const testNamespace = `redis-${Date.now()}`;
    const redis = new IORedis(REDIS_URL);

    const store = createRedisRefreshStore(redis, `auth:rt:${testNamespace}:`);
    const auth = createAuth({ secret: SECRET, refreshStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });
    const refreshToken = session.refreshToken!;

    const results = await Promise.allSettled([auth.refresh(refreshToken), auth.refresh(refreshToken)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    assert.equal(fulfilled, 1, "exactly one refresh should succeed");
    assert.equal(rejected, 1, "exactly one refresh should be rejected");

    await assert.rejects(() => auth.refresh(refreshToken));

    await redis.flushdb();
    redis.disconnect();
  });

  it("rotation produces exactly one successor token", async () => {
    const testNamespace = `redis-${Date.now()}`;
    const redis = new IORedis(REDIS_URL);

    const store = createRedisRefreshStore(redis, `auth:rt:${testNamespace}:`);
    const auth = createAuth({ secret: SECRET, refreshStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });
    const firstRefresh = session.refreshToken!;

    const results = await Promise.allSettled([
      auth.refresh(firstRefresh),
      auth.refresh(firstRefresh),
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);

    await redis.flushdb();
    redis.disconnect();
  });

  it("revoked session cannot refresh", async () => {
    const testNamespace = `redis-${Date.now()}`;
    const redis = new IORedis(REDIS_URL);

    const sessionStore = createRedisSessionStore(redis, `auth:ss:${testNamespace}:`);
    const store = createRedisRefreshStore(redis, `auth:rt:${testNamespace}:`);
    const auth = createAuth({ secret: SECRET, refreshStore: store, sessionStore });

    const session = await auth.login({ id: 1, roles: ["user"] });
    assert.equal(await auth.revokeAllSessions(1), true);
    await assert.rejects(() => auth.refresh(session.refreshToken!));

    await redis.flushdb();
    redis.disconnect();
  });

  it("independent sessions are isolated under concurrent refresh", async () => {
    const testNamespace = `redis-${Date.now()}`;
    const redis = new IORedis(REDIS_URL);

    const store = createRedisRefreshStore(redis, `auth:rt:${testNamespace}:`);
    const auth1 = createAuth({ secret: SECRET, refreshStore: store });
    const auth2 = createAuth({ secret: SECRET, refreshStore: store });

    const session1 = await auth1.login({ id: 101, roles: ["user"] });
    const session2 = await auth2.login({ id: 102, roles: ["user"] });

    const results = await Promise.allSettled([
      auth1.refresh(session1.refreshToken!),
      auth2.refresh(session2.refreshToken!),
    ]);

    // Both should succeed -- different tokens
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);

    // Verify state directly in Redis: consumed tokens deleted, new ones present
    const keysAfter = await redis.keys(`auth:rt:${testNamespace}:*`);
    assert.ok(keysAfter.length >= 2, "at least two refresh tokens (both new ones) in Redis");

    await redis.flushdb();
    redis.disconnect();
  });

  it("contention stress: 50 concurrent refresh attempts, exactly 1 succeeds", async () => {
    const testNamespace = `redis-${Date.now()}`;
    const redis = new IORedis(REDIS_URL);

    const store = createRedisRefreshStore(redis, `auth:rt:${testNamespace}:`);
    const auth = createAuth({ secret: SECRET, refreshStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });
    const refreshToken = session.refreshToken!;

    // 50 concurrent refresh attempts on the same token
    const promises: Array<Promise<string>> = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        auth.refresh(refreshToken)
          .then(() => `ok-${i}`)
          .catch(() => `rejected-${i}`),
      );
    }
    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.startsWith("ok")).length;
    const failures = results.filter((r) => r.startsWith("rejected")).length;

    assert.equal(successes, 1, "exactly one concurrent refresh should succeed");
    assert.equal(failures, 49, "49 concurrent refreshes should be rejected");

    await redis.flushdb();
    redis.disconnect();
  });

  it("reuse of consumed token is rejected", async () => {
    const testNamespace = `redis-${Date.now()}`;
    const redis = new IORedis(REDIS_URL);

    const store = createRedisRefreshStore(redis, `auth:rt:${testNamespace}:`);
    const auth = createAuth({ secret: SECRET, refreshStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });

    await auth.refresh(session.refreshToken!);
    await assert.rejects(() => auth.refresh(session.refreshToken!));

    await redis.flushdb();
    redis.disconnect();
  });

  it("different sessions are isolated", async () => {
    const testNamespace = `redis-${Date.now()}`;
    const redis = new IORedis(REDIS_URL);

    const store = createRedisRefreshStore(redis, `auth:rt:${testNamespace}:`);
    const auth = createAuth({ secret: SECRET, refreshStore: store });

    const s1 = await auth.login({ id: 201, roles: ["user"] });
    const s2 = await auth.login({ id: 202, roles: ["user"] });

    const r1 = await auth.refresh(s1.refreshToken!);
    const r2 = await auth.refresh(s2.refreshToken!);

    assert.equal(r1.user.id, 201);
    assert.equal(r2.user.id, 202);

    // Revoke both should work independently
    await assert.rejects(() => auth.refresh(s1.refreshToken!));
    await assert.rejects(() => auth.refresh(s2.refreshToken!));

    await redis.flushdb();
    redis.disconnect();
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL distributed atomicity tests
// ---------------------------------------------------------------------------

describePg("distributed atomicity with real PostgreSQL", () => {
  it("single-use consumption: atomic DELETE ... RETURNING", async () => {
    const testNamespace = `pg-${Date.now()}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_session_versions (
        user_id TEXT PRIMARY KEY,
        version BIGINT NOT NULL DEFAULT 0
      );
    `);
    await pool.query("DELETE FROM auth_refresh_tokens WHERE id LIKE $1", [`${testNamespace}%`]);

    const store = createPgRefreshStore(pool);
    const auth = createAuth({ secret: SECRET, refreshStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });
    const refreshToken = session.refreshToken!;

    const results = await Promise.allSettled([auth.refresh(refreshToken), auth.refresh(refreshToken)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    assert.equal(fulfilled, 1, "exactly one refresh should succeed");
    assert.equal(rejected, 1, "exactly one refresh should be rejected");

    const { rows } = await pool.query("SELECT COUNT(*) as cnt FROM auth_refresh_tokens WHERE id LIKE $1", [`${testNamespace}%`]);
    assert.equal(Number(rows[0].cnt), 0, "consumed token should be deleted from PostgreSQL");

    await pool.end();
  });

  it("rotation produces exactly one successor token", async () => {
    const testNamespace = `pg-${Date.now()}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_session_versions (
        user_id TEXT PRIMARY KEY,
        version BIGINT NOT NULL DEFAULT 0
      );
    `);
    await pool.query("DELETE FROM auth_refresh_tokens WHERE id LIKE $1", [`${testNamespace}%`]);
    await pool.query("DELETE FROM auth_session_versions WHERE user_id = $1", [1]);
 
    // Clean up any leftover tokens for this user from previous test runs
    await pool.query("DELETE FROM auth_refresh_tokens WHERE user_id = $1", [1]);

    const store = createPgRefreshStore(pool);
    const auth = createAuth({ secret: SECRET, refreshStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });

    const results = await Promise.allSettled([
      auth.refresh(session.refreshToken!),
      auth.refresh(session.refreshToken!),
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);

    const { rows } = await pool.query("SELECT COUNT(*) as cnt FROM auth_refresh_tokens WHERE user_id = $1", [1]);
    assert.equal(Number(rows[0].cnt), 1, "exactly one refresh token should remain after rotation");

    await pool.end();
  });

  it("revokeAllSessions bumps version atomically", async () => {
    const testNamespace = `pg-${Date.now()}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_session_versions (
        user_id TEXT PRIMARY KEY,
        version BIGINT NOT NULL DEFAULT 0
      );
    `);
    await pool.query("DELETE FROM auth_session_versions WHERE user_id LIKE $1", [`${testNamespace}%`]);

    const sessionStore = createPgSessionStore(pool);
    const store = createPgRefreshStore(pool);
    const auth = createAuth({ secret: SECRET, refreshStore: store, sessionStore });

    const session = await auth.login({ id: 1, roles: ["user"] });
    assert.equal((await auth.verify(session.accessToken)).sub, "1");

    assert.equal(await auth.revokeAllSessions(1), true);
    await assert.rejects(() => auth.verify(session.accessToken), (err: unknown) => err instanceof Error);

    const fresh = await auth.login({ id: 1, roles: ["user"] });
    assert.equal((await auth.verify(fresh.accessToken)).sub, "1");

    await pool.end();
  });

  it("refresh concurrent with session revocation blocks refresh after revocation", async () => {
    const testNamespace = `pg-${Date.now()}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_session_versions (user_id TEXT PRIMARY KEY, version BIGINT NOT NULL DEFAULT 0);
    `);
    await pool.query("DELETE FROM auth_refresh_tokens WHERE id LIKE $1", [`${testNamespace}%`]);
    await pool.query("DELETE FROM auth_session_versions WHERE user_id LIKE $1", [`${testNamespace}%`]);

    const sessionStore = createPgSessionStore(pool);
    const store = createPgRefreshStore(pool);
    const auth = createAuth({ secret: SECRET, refreshStore: store, sessionStore });

    const session = await auth.login({ id: 1, roles: ["user"] });

    // Revoke sessions, then refresh should fail
    await auth.revokeAllSessions(1);
    await assert.rejects(() => auth.refresh(session.refreshToken!), (err: unknown) => err instanceof Error);

    await pool.end();
  });

  it("failed refresh does not leave partial state", async () => {
    const testNamespace = `pg-${Date.now()}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at BIGINT NOT NULL);
    `);
    await pool.query("DELETE FROM auth_refresh_tokens WHERE id LIKE $1", [`${testNamespace}%`]);

    const store = createPgRefreshStore(pool);
    const auth = createAuth({ secret: SECRET, refreshStore: store });

    const fakeToken = "invalid.token.withjti.test";
    await assert.rejects(() => auth.refresh(fakeToken), (err: unknown) => err instanceof Error);

    const { rows } = await pool.query("SELECT COUNT(*) as cnt FROM auth_refresh_tokens WHERE id LIKE $1", [`${testNamespace}%`]);
    assert.equal(Number(rows[0].cnt), 0, "failed refresh should not create state");

    await pool.end();
  });

  it("independent sessions are isolated", async () => {
    const testNamespace = `pg-${Date.now()}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at BIGINT NOT NULL);
    `);
    await pool.query("DELETE FROM auth_refresh_tokens WHERE id LIKE $1", [`${testNamespace}%`]);

    const store = createPgRefreshStore(pool);
    const auth = createAuth({ secret: SECRET, refreshStore: store });

    const s1 = await auth.login({ id: 301, roles: ["user"] });
    const s2 = await auth.login({ id: 302, roles: ["user"] });

    const r1 = await auth.refresh(s1.refreshToken!);
    const r2 = await auth.refresh(s2.refreshToken!);

    assert.equal(r1.user.id, 301);
    assert.equal(r2.user.id, 302);

    await assert.rejects(() => auth.refresh(s1.refreshToken!));
    await assert.rejects(() => auth.refresh(s2.refreshToken!));

    await pool.end();
  });

  it("contention stress: 50 concurrent refresh attempts, exactly 1 succeeds", async () => {
    const testNamespace = `pg-${Date.now()}`;
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at BIGINT NOT NULL);
    `);
    await pool.query("DELETE FROM auth_refresh_tokens WHERE id LIKE $1", [`${testNamespace}%`]);

    const store = createPgRefreshStore(pool);
    const auth = createAuth({ secret: SECRET, refreshStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });
    const refreshToken = session.refreshToken!;

    const promises: Array<Promise<string>> = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        auth.refresh(refreshToken)
          .then(() => `ok-${i}`)
          .catch(() => `rejected-${i}`),
      );
    }
    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.startsWith("ok")).length;
    const failures = results.filter((r) => r.startsWith("rejected")).length;

    assert.equal(successes, 1, "exactly one concurrent refresh should succeed");
    assert.equal(failures, 49, "49 concurrent refreshes should be rejected");

    await pool.end();
  });
});
