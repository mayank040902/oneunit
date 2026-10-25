import { test } from "vitest";
import assert from "node:assert/strict";
import { createSentinelClient, shutdown } from "../../dist/client/index.js";
import { silentLogger } from "../../dist/logger.js";

test("createSentinelClient validates sentinel configuration", () => {
  assert.throws(() => createSentinelClient({ sentinels: [], name: "m" } as never, silentLogger), /Sentinel connection/i);
  assert.throws(() => createSentinelClient({ sentinels: [{ host: "x", port: 1 }], name: "" } as never, silentLogger), /master name/i);
});

test("createSentinelClient starts disconnected for lazy connection", () => {
  const client = createSentinelClient(
    { sentinels: [{ host: "127.0.0.1", port: 6399 }], name: "mymaster", retryStrategy: () => null, connectTimeout: 100 },
    silentLogger,
  );

  try {
    assert.equal(client.status, "wait");
  } finally {
    client.disconnect();
    shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("createSentinelClient preserves lazy connection for many clients", () => {
  const clients = [];
  try {
    for (let i = 0; i < 100; i++) {
      clients.push(
        createSentinelClient(
          {
            sentinels: [{ host: "127.0.0.1", port: 6399 }],
            name: "mymaster",
            retryStrategy: () => null,
            connectTimeout: 10,
          },
          silentLogger,
        ),
      );
    }

    for (const client of clients) {
      assert.equal(client.status, "wait");
    }
  } finally {
    for (const client of clients) {
      client.disconnect();
    }
  }
});

test("createSentinelClient applies a custom error profile", () => {
  const kinds = [];
  const client = createSentinelClient(
    {
      sentinels: [{ host: "127.0.0.1", port: 6399 }],
      name: "mymaster",
      retryStrategy: () => null,
      connectTimeout: 10,
      errorHandling: {
        enabled: true,
        logger: silentLogger,
        onError: (_error, classification) => kinds.push(classification.kind),
      },
    },
    silentLogger,
  );

  try {
    assert.equal(client.status, "wait");
  } finally {
    client.disconnect();
  }
});
