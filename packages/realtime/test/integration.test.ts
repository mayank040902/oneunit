import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { fastifyWebsocket } from "@fastify/websocket";
import "../src/fastify.js";
import { registerRealtime } from "../src/plugin.js";
import { decodeMessage } from "../src/hub.js";

interface TestClient {
  socket: WebSocket;
  frames: Buffer[];
  next(timeout?: number): Promise<Buffer>;
  closeCode(timeout?: number): Promise<number>;
}

const clients: TestClient[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.socket.terminate();
  }

  for (const app of apps.splice(0)) {
    await app.close().catch(() => {});
  }
});

function createApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  apps.push(app);
  return app;
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();

  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }

  return `ws://127.0.0.1:${address.port}`;
}

function connect(url: string): Promise<TestClient> {
  const socket = new WebSocket(url);
  const frames: Buffer[] = [];
  const waiters: Array<(frame: Buffer) => void> = [];
  const closeWaiters: Array<(code: number) => void> = [];

  const client: TestClient = {
    socket,
    frames,
    next(timeout = 3000) {
      const buffered = frames.shift();
      if (buffered) {
        return Promise.resolve(buffered);
      }

      return new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("no frame received before timeout"));
        }, timeout);

        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
    closeCode(timeout = 3000) {
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("socket did not close before timeout"));
        }, timeout);

        closeWaiters.push((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
  };

  socket.on("message", (data) => {
    const frame = data as Buffer;
    const waiter = waiters.shift();

    if (waiter) {
      waiter(frame);
      return;
    }

    frames.push(frame);
  });

  socket.on("close", (code) => {
    for (const waiter of closeWaiters.splice(0)) {
      waiter(code);
    }
  });

  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      clients.push(client);
      resolve(client);
    });
    socket.once("error", reject);
  });
}

function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
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

describe("registerRealtime with @fastify/websocket", () => {
  it("broadcasts to a real client over the hub", async () => {
    const app = createApp();
    let connections = 0;

    const hub = await registerRealtime(app, {
      heartbeat: false,
      routes: async (server) => {
        server.get("/ws/room", { websocket: true }, async (socket) => {
          connections++;
          const clientId = `client-${connections}`;
          const connection = { id: clientId, connection: socket };

          await hub.join("room", connection);
          await hub.send(connection, { type: "welcome" });

          socket.on("close", () => {
            void hub.leave("room", clientId);
          });
        });
      },
    });

    const url = await listen(app);
    const client = await connect(`${url}/ws/room`);

    expect(decodeMessage(await client.next())).toEqual({ type: "welcome" });
    expect(connections).toBe(1);

    await waitFor(() => hub.channelCount("room") === 1);

    const update = client.next();
    expect(await hub.broadcast("room", { type: "update", value: 7 })).toBe(1);
    expect(decodeMessage(await update)).toEqual({ type: "update", value: 7 });

    client.socket.close();
    await waitFor(() => hub.totalSubscribers() === 0);
  });

  it("rejects a client whose socket is not a WebSocket", async () => {
    const app = createApp();
    let failure: unknown = null;

    const hub = await registerRealtime(app, {
      heartbeat: false,
      routes: async (server) => {
        server.get("/ws/room", { websocket: true }, async (connection: unknown) => {
          try {
            await hub.join("room", {
              id: "c1",
              connection: (connection as { socket: unknown }).socket as never,
            });
          } catch (error) {
            failure = error;
          }
        });
      },
    });

    const url = await listen(app);
    await connect(`${url}/ws/room`);
    await waitFor(() => failure !== null);

    expect((failure as Error).message).toMatch(/connection with send\(\) and close\(\)/i);
    expect(hub.channelCount("room")).toBe(0);
  });

  it("closes client sockets when the app shuts down", async () => {
    const app = createApp();

    const hub = await registerRealtime(app, {
      heartbeat: false,
      routes: async (server) => {
        server.get("/ws/room", { websocket: true }, async (socket) => {
          await hub.join("room", { id: "c1", connection: socket });
        });
      },
    });

    const url = await listen(app);
    const client = await connect(`${url}/ws/room`);
    await waitFor(() => hub.channelCount("room") === 1);

    const closed = client.closeCode();
    await app.close();
    apps.splice(apps.indexOf(app), 1);

    expect(await closed).toBeGreaterThanOrEqual(1000);
    expect(hub.isClosed).toBe(true);
    expect(hub.totalSubscribers()).toBe(0);
  });

  it("enables E2EE at registration time", async () => {
    const app = createApp();
    const hub = await registerRealtime(app, { e2ee: true, heartbeat: false });

    expect(hub.isE2EEEnabled).toBe(true);
    expect(hub.e2eePublicKey).not.toBeNull();
  });

  it("decorates the instance and runs the routes callback", async () => {
    const app = createApp();
    let routed: unknown = null;

    const hub = await registerRealtime(app, {
      heartbeat: false,
      routes: async (server) => {
        routed = server;
        server.get("/ws/room", { websocket: true }, async () => {});
      },
    });

    expect(app.realtime).toBe(hub);
    expect(routed).toBe(app);
  });

  it("refuses to register twice on the same instance", async () => {
    const app = createApp();
    await registerRealtime(app, { heartbeat: false });

    await expect(registerRealtime(app, { heartbeat: false })).rejects.toThrow(
      /already registered/i,
    );
  });

  it("rejects an unknown websocket library", async () => {
    const app = createApp();

    await expect(
      registerRealtime(app, { websocketLibrary: "socket-io" as never }),
    ).rejects.toThrow(/Unknown websocketLibrary/);
  });

  it("skips @fastify/websocket registration when the app already has it", async () => {
    const app = createApp();
    const warnings: unknown[] = [];

    await app.register(fastifyWebsocket);

    const hub = await registerRealtime(app, {
      heartbeat: false,
      logger: {
        info: () => {},
        warn: (payload: unknown) => warnings.push(payload),
        error: () => {},
      },
    });

    expect(hub.totalSubscribers()).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it("caps the accepted frame size", async () => {
    const app = createApp();

    await registerRealtime(app, {
      heartbeat: false,
      maxPayload: 256,
      routes: async (server) => {
        server.get("/ws/room", { websocket: true }, async () => {});
      },
    });

    const url = await listen(app);
    const client = await connect(`${url}/ws/room`);
    const closed = client.closeCode();

    client.socket.send(Buffer.alloc(1024, 1));

    expect(await closed).toBe(1009);
  });
});

describe("registerRealtime with the ws library", () => {
  it("joins the configured channel and routes messages to the handler", async () => {
    const app = createApp();
    const received: unknown[] = [];
    const clientIds: string[] = [];

    const hub = await registerRealtime(app, {
      websocketLibrary: "ws",
      path: "/ws",
      channel: "lobby",
      heartbeat: false,
      onConnection: (connection) => {
        clientIds.push(connection.clientId);
      },
      onMessage: (message) => {
        received.push(message);
      },
    });

    const url = await listen(app);
    const client = await connect(`${url}/ws/lobby`);
    await waitFor(() => hub.channelCount("lobby") === 1);

    expect(hub.channelCount("lobby")).toBe(1);
    expect(clientIds).toEqual([hub.participants("lobby")[0].id]);

    client.socket.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ type: "ping" });

    const pong = client.next();
    expect(await hub.broadcast("lobby", { type: "pong" })).toBe(1);
    expect(decodeMessage(await pong)).toEqual({ type: "pong" });

    client.socket.close();
    await waitFor(() => hub.totalSubscribers() === 0);
  });

  it("survives a client socket error without taking the process down", async () => {
    const app = createApp();
    const hub = await registerRealtime(app, {
      websocketLibrary: "ws",
      path: "/ws",
      heartbeat: false,
    });

    const url = await listen(app);
    const client = await connect(`${url}/ws/room`);
    await waitFor(() => hub.totalSubscribers() === 1);

    client.socket.terminate();

    await waitFor(() => hub.totalSubscribers() === 0);
    expect(hub.isClosed).toBe(false);
  });

  it("does not claim upgrade paths outside the configured prefix", async () => {
    const app = createApp();
    const hub = await registerRealtime(app, {
      websocketLibrary: "ws",
      path: "/ws",
      heartbeat: false,
    });

    const url = await listen(app);
    await expect(connect(`${url}/other`)).rejects.toThrow();

    expect(hub.totalSubscribers()).toBe(0);
  });

  it("removes the upgrade listener on close", async () => {
    const app = createApp();
    const before = app.server.listenerCount("upgrade");

    await registerRealtime(app, {
      websocketLibrary: "ws",
      path: "/ws",
      heartbeat: false,
    });

    expect(app.server.listenerCount("upgrade")).toBe(before + 1);

    await app.close();
    apps.splice(apps.indexOf(app), 1);

    expect(app.server.listenerCount("upgrade")).toBe(before);
  });

  it("pings a real client and keeps it connected while it answers", async () => {
    const app = createApp();
    const hub = await registerRealtime(app, {
      websocketLibrary: "ws",
      path: "/ws",
      heartbeatInterval: 250,
    });

    const url = await listen(app);
    const client = await connect(`${url}/ws/room`);
    await waitFor(() => hub.totalSubscribers() === 1);

    // A ws client answers a ping automatically, so receiving one proves the
    // heartbeat reached a real socket and that it was not torn down.
    const pinged = new Promise<void>((resolve) => {
      client.socket.once("ping", () => resolve());
    });

    await pinged;

    expect(hub.channelCount("default")).toBe(1);

    const closed = client.closeCode();
    hub.close();

    expect(await closed).toBe(1001);
    expect(hub.isClosed).toBe(true);
  });
});
