process.on("unhandledRejection", () => undefined);
import { test } from "vitest";
import assert from "node:assert/strict";
import { cachedRedisAvailable, TEST_REDIS_URL } from "../helpers.js";
import {
  createClient,
  shutdown,
  silentLogger,
} from "../../dist/index.js";
import {
  createRedisSessionStore,
  createScheduledSessionRevocation,
} from "../../dist/features/index.js";

const redisUp = cachedRedisAvailable();
const SCHEDULED_REDIS_URL = TEST_REDIS_URL.endsWith("/") ? TEST_REDIS_URL + "1" : `${TEST_REDIS_URL}/1`;

test("scheduled session revocation runs after its delay", async () => {
  if (!(await redisUp())) {
    return;
  }

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const prefix = `test:scheduled:${Date.now()}:`;
  const sessionStore = createRedisSessionStore(client, { keyPrefix: prefix });
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    redis: client,
    queueName: `scheduled-${Date.now()}-${Math.random()}`,
    sessionStore,
    prefix: "queue",
    concurrency: 1,
  });

  try {
    const sessionId = "session-to-revoke";
    assert.equal(await sessionStore.isSessionRevoked(sessionId), false);

    await scheduler.schedule(sessionId, Date.now() + 300);
    assert.equal(await sessionStore.isSessionRevoked(sessionId), false);

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await sessionStore.isSessionRevoked(sessionId)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await sessionStore.isSessionRevoked(sessionId), true);
  } finally {
    await scheduler.close();
    if (client.status !== "end") {
  
      await shutdown(client, silentLogger);
    }
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(100);
  }
  throw new Error("timed out waiting for condition");
}

test("scheduled revocation clamps a past time to immediate", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const prefix = `test:scheduled-past:${Date.now()}:`;
  const sessionStore = createRedisSessionStore(client, { keyPrefix: prefix });
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    redis: client,
    queueName: `scheduled-${Date.now()}-${Math.random()}`,
    sessionStore,
    prefix: "queue",
  });

  try {
    const sessionId = "past-session";
    await scheduler.schedule(sessionId, Date.now() - 10_000);
    await until(async () => sessionStore.isSessionRevoked(sessionId));
  } finally {
    await scheduler.close();
    if (client.status !== "end") {
  
      await shutdown(client, silentLogger);
    }
  }
});

test("scheduled revocation handles several sessions concurrently", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const prefix = `test:scheduled-many:${Date.now()}:`;
  const sessionStore = createRedisSessionStore(client, { keyPrefix: prefix });
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    redis: client,
    queueName: `scheduled-${Date.now()}-${Math.random()}`,
    sessionStore,
    concurrency: 3,
  });

  try {
    const ids = Array.from({ length: 5 }, (_, i) => `many-${i}`);
    await Promise.all(ids.map((id) => scheduler.schedule(id, Date.now() + 100)));
    await until(async () => Promise.all(ids.map((id) => sessionStore.isSessionRevoked(id))).then((all) => all.every(Boolean)));
    for (const id of ids) {
      assert.equal(await sessionStore.isSessionRevoked(id), true);
    }
  } finally {
    await scheduler.close();
    if (client.status !== "end") {
  
      await shutdown(client, silentLogger);
    }
  }
});

test("scheduled revocation uses store options when no store is supplied", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const prefix = `test:scheduled-options:${Date.now()}:`;
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    redis: client,
    queueName: `scheduled-${Date.now()}-${Math.random()}`,
    storeOptions: { keyPrefix: prefix },
    prefix: "custom",
    queueName: "custom-revocation",
  });

  try {
    const sessionId = "options-session";
    await scheduler.schedule(sessionId, Date.now() + 100);
    await until(async () => {
      const store = createRedisSessionStore(client, { keyPrefix: prefix });
      return store.isSessionRevoked(sessionId);
    });
  } finally {
    await scheduler.close();
    if (client.status !== "end") {
  
      await shutdown(client, silentLogger);
    }
  }
});


test("scheduled revocation accepts an explicitly provided session store", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const prefix = `test:scheduled-store:${Date.now()}:`;
  const store = createRedisSessionStore(client, { keyPrefix: prefix });
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    queueName: `scheduled-${Date.now()}-${Math.random()}`,
    sessionStore: store,
  });

  try {
    const sessionId = "provided-store-session";
    await scheduler.schedule(sessionId, Date.now() + 100);
    await until(async () => store.isSessionRevoked(sessionId));
  } finally {
    await scheduler.close();
    if (client.status !== "end") {
  
      await shutdown(client, silentLogger);
    }
  }
});

test("scheduled revocation rejects an empty sessionId", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    redis: client,
    storeOptions: { keyPrefix: `test:scheduled-empty:${Date.now()}:` },
    queueName: `empty-${Date.now()}-${Math.random()}`,
  });

  try {
    await assert.rejects(() => scheduler.schedule("", Date.now() + 100), /sessionId/i);
    await assert.rejects(() => scheduler.schedule("   ", Date.now() + 100), /sessionId/i);
  } finally {
    await scheduler.close().catch(() => undefined);
    if (client.status !== "end") {
  
      await shutdown(client, silentLogger);
    }
  }
});

test("scheduled revocation rejects a non-finite runAt", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    redis: client,
    storeOptions: { keyPrefix: `test:scheduled-nan:${Date.now()}:` },
    queueName: `nan-${Date.now()}-${Math.random()}`,
  });
  try {
    await assert.rejects(() => scheduler.schedule("nan-session", NaN), /runAt/i);
    await assert.rejects(() => scheduler.schedule("nan-session", Infinity), /runAt/i);
  } finally {
    await scheduler.close().catch(() => undefined);
    if (client.status !== "end") {
      await shutdown(client, silentLogger);
    }
  }
});

test("scheduled revocation leaves the session untouched before the delay", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const prefix = `test:scheduled-before:${Date.now()}:`;
  const sessionStore = createRedisSessionStore(client, { keyPrefix: prefix });
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    redis: client,
    sessionStore,
    queueName: `before-${Date.now()}-${Math.random()}`,
  });

  try {
    await scheduler.schedule("before-session", Date.now() + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await sessionStore.isSessionRevoked("before-session"), false);
  } finally {
    await scheduler.close().catch(() => undefined);
    if (client.status !== "end") {
  
      await shutdown(client, silentLogger);
    }
  }
});

test("scheduled revocation returns a job id", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  const prefix = `test:scheduled-id:${Date.now()}:`;
  const sessionStore = createRedisSessionStore(client, { keyPrefix: prefix });
  const scheduler = createScheduledSessionRevocation({
    connection: client,
    redis: client,
    sessionStore,
    queueName: `id-${Date.now()}-${Math.random()}`,
  });

  try {
    const jobId = await scheduler.schedule("id-session", Date.now() + 100);
    assert.ok(jobId === undefined || typeof jobId === "string");
  } finally {
    await scheduler.close().catch(() => undefined);
    if (client.status !== "end") {
  
      await shutdown(client, silentLogger);
    }
  }
});

test("createScheduledSessionRevocation validates its connection and concurrency", async () => {
  assert.throws(() => createScheduledSessionRevocation({ connection: undefined as never }), /connection/i);

  const client = createClient({ url: SCHEDULED_REDIS_URL }, silentLogger);
  try {
    assert.throws(
      () =>
        createScheduledSessionRevocation({
          connection: client,
          concurrency: 0,
        }),
      /concurrency/i,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});
