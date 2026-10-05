import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { decodeMessage } from "../src/hub.js";
import { createRealtimeHub, matchesRealtimePath, registerRealtime } from "../src/plugin.js";
import { AuthorizationError, ChannelError } from "../src/errors.js";
import { RealtimeHub } from "../src/hub.js";

describe("createRealtimeHub", () => {
  it("is re-exported from the plugin entry point", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });

    expect(hub).toBeInstanceOf(RealtimeHub);
    expect(hub.channelCount("room")).toBe(0);
    expect(hub.isClosed).toBe(false);
    hub.close();
  });

  it("accepts delivery limits", async () => {
    const hub = await createRealtimeHub({
      heartbeat: false,
      backpressure: { maxBufferedBytes: 1024, maxConsecutiveDrops: 4 },
      limits: { maxMessageSize: 1024 },
    });

    expect(hub.limits.maxMessageSize).toBe(1024);
    hub.close();
  });
});

describe("registerRealtime", () => {
  it("registers a hub, joins connections and shuts down cleanly", async () => {
    const app = Fastify();

    try {
      const hub = await registerRealtime(app, {
        websocketLibrary: "ws",
        path: "/ws",
        channel: "lobby",
        heartbeat: false,
        onConnection: (connection) => {
          connection.hub.broadcast("lobby", { joined: connection.clientId });
        },
      });

      expect(app.hasDecorator("realtime")).toBe(true);
      expect(hub.isClosed).toBe(false);

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const received = await connect(`ws://127.0.0.1:${port}/ws`);
      console.log("DBG opened, hub clients", hub.clientCount());
      const first = await Promise.race([received.firstMessage, new Promise((r)=>setTimeout(()=>r("TIMEOUT"),2000))]);
      console.log("DBG first", JSON.stringify(first), "hub clients", hub.clientCount());

      expect(first).toHaveProperty("joined");

      const second = await connect(`ws://127.0.0.1:${port}/ws`);
      expect(await second.firstMessage).toHaveProperty("joined");
      expect(hub.channelCount("lobby")).toBe(2);
      expect(hub.totalSubscribers()).toBe(2);

      received.socket.close();
      second.socket.close();

      await app.close();

      expect(hub.isClosed).toBe(true);
      expect(hub.channelCount("lobby")).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("shuts down even while a client is still connected", async () => {
    const app = Fastify();

    try {
      const hub = await registerRealtime(app, {
        websocketLibrary: "ws",
        channel: "lobby",
        heartbeat: false,
        onConnection: (connection) => {
          connection.hub.broadcast("lobby", { joined: connection.clientId });
        },
      });

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const client = await connect(`ws://127.0.0.1:${port}/ws`);
      await client.firstMessage;

      // No client-side close: shutdown must not wait for the handshake.
      await app.close();

      expect(hub.isClosed).toBe(true);
      expect(hub.channelCount("lobby")).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("hands the hub to app-owned routes when attachConnections is false", async () => {
    // The opt-out exists for an app that routes its own sockets. The contract is
    // that registration still decorates the instance and still returns a hub the
    // app's own handler can join against.
    const app = Fastify();
    let hub: Awaited<ReturnType<typeof registerRealtime>> | undefined;

    try {
      hub = await registerRealtime(app, {
        attachConnections: false,
        heartbeat: false,
        routes: async (server) => {
          server.get("/ws/own", { websocket: true }, async (socket) => {
            await hub?.join("own", { connection: socket as never });
          });
        },
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const port = (app.server.address() as AddressInfo).port;

      const outcome = await new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/own`);
        socket.on("open", () => resolve("open"));
        socket.on("error", (error: Error) => resolve(`error: ${error.message}`));
        setTimeout(() => resolve("timeout"), 2000);
      });

      // Nothing claimed the upgrade, so the app's own route is the only handler.
      expect(outcome).toBe("open");
      expect(hub.channelCount("own")).toBe(1);
      expect(hub.isClosed).toBe(false);
    } finally {
      await app.close();
      // The hub is closed with the app even though the app owned the sockets.
      expect(hub?.isClosed).toBe(true);
    }
  });

  it("leaves the app's own upgrade handler working in ws mode", async () => {
    // Owning the upgrade must not swallow paths the plugin does not serve, or an
    // app with its own WebSocket endpoint would lose it silently.
    const app = Fastify();
    const hub = await registerRealtime(app, { websocketLibrary: "ws", heartbeat: false });

    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const port = (app.server.address() as AddressInfo).port;

      const outcome = await new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/nope`);
        socket.on("open", () => resolve("open"));
        socket.on("error", () => resolve("refused"));
        socket.on("close", () => resolve("closed"));
        setTimeout(() => resolve("timeout"), 2000);
      });

      expect(outcome).not.toBe("open");
      expect(hub.clientCount()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("refuses a second registration on the same instance", async () => {
    const app = Fastify();

    try {
      await registerRealtime(app, { websocketLibrary: "ws", heartbeat: false });
      await expect(registerRealtime(app, { heartbeat: false })).rejects.toThrow(
        /already registered/i,
      );
    } finally {
      await app.close();
    }
  });

  it("keeps independent state per Fastify instance", async () => {
    const first = Fastify();
    const second = Fastify();
    const firstHub = await registerRealtime(first, {
      websocketLibrary: "ws",
      channel: "a",
      heartbeat: false,
    });
    const secondHub = await registerRealtime(second, {
      websocketLibrary: "ws",
      channel: "b",
      heartbeat: false,
    });

    try {
      expect(firstHub).not.toBe(secondHub);

      const connection = {
        readyState: 1,
        send() {},
        close() {},
      };

      await firstHub.join("a", { id: "c1", connection });
      expect(firstHub.channelCount("a")).toBe(1);
      expect(secondHub.channelCount("a")).toBe(0);
    } finally {
      await first.close();
      expect(firstHub.isClosed).toBe(true);
      await second.close();
      expect(secondHub.isClosed).toBe(true);
    }
  });

  it("refuses an unauthenticated peer before the handshake", async () => {
    const app = Fastify();

    try {
      const hub = await registerRealtime(app, {
        websocketLibrary: "ws",
        channel: "lobby",
        heartbeat: false,
        authenticate: ({ request }) => {
          const url = new URL((request as { url?: string })?.url ?? "/", "http://localhost");

          if (!url.searchParams.has("token")) {
            throw new Error("missing token");
          }

          return { user: url.searchParams.get("token") };
        },
      });

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      // This mode owns the upgrade, so the handshake waits for the hook: a peer
      // that cannot authenticate is answered with a plain HTTP error instead of
      // being handed an open socket it would then have to be closed out of.
      const rejected = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const message = await new Promise<string>((resolve) => {
        rejected.on("open", () => resolve("opened"));
        rejected.on("error", (error: Error) => resolve(error.message));
      });

      expect(message).toContain("401");
      expect(hub.clientCount()).toBe(0);

      const accepted = await new WebSocket(`ws://127.0.0.1:${port}/ws?token=alice`);
      await new Promise<void>((resolve, reject) => {
        accepted.once("open", () => resolve());
        accepted.once("error", reject);
      });

      await waitFor(() => hub.channelCount("lobby") === 1);
      accepted.terminate();
    } finally {
      await app.close();
    }
  });

  it("closes connections that authorization rejects", async () => {
    const app = Fastify();

    try {
      const hub = await registerRealtime(app, {
        websocketLibrary: "ws",
        channel: "locked",
        heartbeat: false,
        authorize: ({ action, channel }) => !(action === "join" && channel === "locked"),
      });

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const rejected = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const closeCode = await new Promise<number>((resolve) => {
        rejected.on("close", (code) => resolve(code));
      });

      expect(closeCode).toBe(1008);
      expect(hub.channelCount("locked")).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("enforces hub limits on live connections", async () => {
    const app = Fastify();

    try {
      const hub = await registerRealtime(app, {
        websocketLibrary: "ws",
        channel: "lobby",
        heartbeat: false,
        limits: { maxConnections: 1 },
      });

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      // No onConnection handler, so this client only proves the join happened.
      const first = await connect(`ws://127.0.0.1:${port}/ws`);

      const second = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const closeCode = await new Promise<number>((resolve) => {
        second.on("close", (code) => resolve(code));
      });

      expect(closeCode).toBe(1013);
      expect(hub.channelCount("lobby")).toBe(1);
      first.socket.close();
    } finally {
      await app.close();
    }
  });

  it("closes the hub when Fastify closes", async () => {
    const app = Fastify();
    const hub = await registerRealtime(app, {
      websocketLibrary: "ws",
      heartbeat: false,
    });

    await app.close();
    expect(hub.isClosed).toBe(true);
  });
});

describe("matchesRealtimePath", () => {
  it("matches the path itself and its children", () => {
    expect(matchesRealtimePath("/ws", "/ws")).toBe(true);
    expect(matchesRealtimePath("/ws/chat", "/ws")).toBe(true);
    expect(matchesRealtimePath("/ws/chat?token=1", "/ws")).toBe(true);
    expect(matchesRealtimePath("/ws/", "/ws/")).toBe(true);
  });

  it("does not match unrelated or prefixed paths", () => {
    expect(matchesRealtimePath("/wsx", "/ws")).toBe(false);
    expect(matchesRealtimePath("/api/ws", "/ws")).toBe(false);
    expect(matchesRealtimePath("/wsx", "/ws/")).toBe(false);
    expect(matchesRealtimePath(undefined, "/ws")).toBe(false);
  });
});

describe("exported error types", () => {
  it("carry machine-readable codes", () => {
    expect(new ChannelError("bad", { channel: "x" }).code).toBe("CHANNEL_ERROR");
    expect(new ChannelError("bad", { channel: "x" }).channel).toBe("x");
    expect(new AuthorizationError("join").action).toBe("join");
    expect(new AuthorizationError("join").code).toBe("AUTHORIZATION_ERROR");
  });
});

interface Client {
  socket: WebSocket;
  /** Resolves with the first frame, which can arrive in the same tick as `open`. */
  firstMessage: Promise<unknown>;
}

/** Listeners are attached before `open`, so no frame can be missed. */
async function connect(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  const firstMessage = new Promise<unknown>((resolve, reject) => {
    socket.on("message", (data) => resolve(decodeMessage(data as Buffer)));
    socket.on("error", reject);
  });

  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });

  return { socket, firstMessage };
}

/** Joins and the close handshake both land asynchronously. */
async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const startedAt = Date.now();

  await new Promise<void>((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeout) {
        reject(new Error("condition not met before timeout"));
        return;
      }

      setTimeout(tick, 10);
    };

    tick();
  });
}