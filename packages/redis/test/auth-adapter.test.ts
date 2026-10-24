import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Redis from "ioredis";
import { createAuth } from "@oneunit/auth";
import {
  createRedisRefreshStore,
  createRedisSessionStore,
  createRedisStateStore,
} from "../src/features/index.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const SECRET = "adapter-test-secret";

async function redisAvailable(): Promise<boolean> {
  try {
    const client = new Redis(REDIS_URL, { connectTimeout: 1000, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    return pong === "PONG";
  } catch {
    return false;
  }
}

const describeRedis = (await redisAvailable()) ? describe : describe.skip;

describeRedis("Redis auth adapter", () => {
  it("refresh rotation atomic", async () => {
    const redis = new Redis(REDIS_URL);
    const ns = `a:${Date.now()}`;
    const store = createRedisRefreshStore(redis, { keyPrefix: ns });
    const auth = createAuth({ secret: SECRET, refreshStore: store });
    const session = await auth.login({ id: 1, roles: ["user"] });
    const results = await Promise.allSettled([
      auth.refresh(session.refreshToken!),
      auth.refresh(session.refreshToken!),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    await redis.flushdb();
    redis.disconnect();
  });

  it("state consume single-use", async () => {
    const redis = new Redis(REDIS_URL);
    const ns = `b:${Date.now()}`;
    const store = createRedisStateStore(redis, { keyPrefix: ns });
    await store.set("s", { x: 1 }, 60);
    const first = await store.consume("s");
    const second = await store.consume("s");
    assert.deepEqual(first, { x: 1 });
    assert.equal(second, null);
    await redis.flushdb();
    redis.disconnect();
  });

  it("session revocation", async () => {
    const redis = new Redis(REDIS_URL);
    const ns = `c:${Date.now()}`;
    const sessionStore = createRedisSessionStore(redis, { keyPrefix: ns });
    const auth = createAuth({ secret: SECRET, sessionStore });
    const session = await auth.login({ id: 1, roles: ["user"] });
    assert.equal(await auth.revokeSession(String(session.payload.sid)), true);
    await assert.rejects(() => auth.verify(session.accessToken));
    await redis.flushdb();
    redis.disconnect();
  });
});
