import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { encode } from "notepack.io";
import { decodeMessage } from "../src/hub.js";
import {
  attachWebSocketAdapter,
  createConnectionAdapter,
  matchesPath,
  type ConnectionAdapter,
} from "../src/adapter.js";
import { createRealtimeHub } from "../src/hub.js";

// A minimal connection that satisfies the hub contract with no emitter at all,
// which is the point of the abstraction: the hub needs no transport API.
function makeConnection(): {
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  terminate?: () => void;
} {
  return {
    readyState: 1,
    send() {},
    close() {
      this.readyState = 3;
    },
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("createConnectionAdapter", () => {
  it("authenticates, joins and reports the client", async () => {
    // The hook belongs to the hub: an adapter only decides when to call it.
    const hub = await createRealtimeHub({
      heartbeat: false,
      authenticate: ({ request }) => ({
        agent: (request as { agent?: string })?.agent ?? "unknown",
      }),
    });
    const adapter = createConnectionAdapter({ hub, channel: "lobby" });

    const client = await adapter.attach(makeConnection(), { agent: "curl" });

    expect(client).not.toBeNull();
    expect(hub.channelCount("lobby")).toBe(1);
    expect(client?.metadata).toEqual({ agent: "curl" });
    // The channel lives on the connection context and in the hub, not on Client.
    expect(hub.channelsFor(client?.id as string)).toEqual(["lobby"]);
    expect(adapter.size).toBe(1);

    hub.close();
  });

  it("survives a refused socket that is still handshaking", async () => {
    // `ws` reports a socket closed before the handshake finished by emitting
    // `error` on a later tick. The rejection paths close the socket before any
    // listener is wired, so an unabsorbed error surfaced as an uncaught exception
    // and a refused peer could take the process down.
    const hub = await createRealtimeHub({
      heartbeat: false,
      authenticate: () => {
        throw new Error("no token");
      },
    });
    const adapter = createConnectionAdapter({ hub });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };

    process.on("uncaughtException", onUncaught);

    try {
      // Still CONNECTING: the target port is closed, so the handshake never
      // completes and the close is the abort path.
      const socket = new WebSocket("ws://127.0.0.1:1/ws");

      expect(await adapter.attach(socket as never)).toBeNull();

      // The error is emitted on the next tick, after attach has already resolved.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(uncaught).toEqual([]);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      process.off("uncaughtException", onUncaught);
      hub.close();
    }
  });

  it("refuses a connection the authentication hook rejects", async () => {
    const hub = await createRealtimeHub({
      heartbeat: false,
      authenticate: () => {
        throw new Error("no token");
      },
    });
    const adapter = createConnectionAdapter({ hub });
    const connection = makeConnection();
    let closed: { code?: number; reason?: string } | null = null;
    connection.close = (code?: number, reason?: string) => {
      closed = { code, reason };
      connection.readyState = 3;
    };

    expect(await adapter.attach(connection)).toBeNull();
    expect(closed).toEqual({ code: 1008, reason: "Unauthorized" });
    expect(hub.clientCount()).toBe(0);
    expect(adapter.size).toBe(0);

    hub.close();
  });

  it("refuses a join the authorize hook denies", async () => {
    const hub = await createRealtimeHub({
      heartbeat: false,
      authorize: ({ channel }) => channel !== "locked",
    });
    const adapter = createConnectionAdapter({ hub, channel: "locked" });
    const connection = makeConnection();
    const codes: number[] = [];
    connection.close = (code?: number) => {
      codes.push(code as number);
      connection.readyState = 3;
    };

    expect(await adapter.attach(connection)).toBeNull();
    expect(codes).toEqual([1008]);
    expect(hub.channelCount("locked")).toBe(0);

    hub.close();
  });

  it("routes decoded frames to onMessage", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });
    const received: unknown[] = [];
    const adapter = createConnectionAdapter({
      hub,
      onMessage: (message) => {
        received.push(message);
      },
    });
    const client = await adapter.attach(makeConnection());

    const context = {
      clientId: client?.id as string,
      channel: "default",
      connection: makeConnection(),
      hub,
      metadata: {},
    };

    // Binary frames are notepack, text frames are JSON when they parse.
    await adapter.handleMessage(context, encode({ type: "binary" }));
    await adapter.handleMessage(context, JSON.stringify({ type: "text" }), false);
    await adapter.handleMessage(context, "not json", false);

    expect(received).toEqual([{ type: "binary" }, { type: "text" }, "not json"]);

    hub.close();
  });

  it("works with a connection that has no event emitter", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });
    const adapter = createConnectionAdapter({ hub });

    const client = await adapter.attach(makeConnection());
    await adapter.release(client?.id as string);

    expect(hub.hasClient(client?.id as string)).toBe(false);

    hub.close();
  });

  it("terminates every attached socket on close", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });
    const adapter: ConnectionAdapter = createConnectionAdapter({ hub });
    const connections = [makeConnection(), makeConnection()];
    const terminated: boolean[] = [];

    for (const connection of connections) {
      connection.terminate = () => {
        terminated.push(true);
        connection.readyState = 3;
      };
      await adapter.attach(connection);
    }

    expect(adapter.size).toBe(2);

    adapter.close();

    expect(terminated).toEqual([true, true]);
    expect(adapter.size).toBe(0);

    hub.close();
  });

  it("refuses to attach once the hub is closed", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });
    const adapter = createConnectionAdapter({ hub });
    const connection = makeConnection();
    const codes: number[] = [];
    connection.close = (code?: number) => {
      codes.push(code as number);
      connection.readyState = 3;
    };

    hub.close();

    expect(await adapter.attach(connection)).toBeNull();
    expect(codes).toEqual([1001]);
  });
});

describe("attachWebSocketAdapter on a plain node:http server", () => {
  it("serves the hub without any framework", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, stats: hub.stats() }));
    });

    const attached = await attachWebSocketAdapter(server, {
      hub,
      path: "/ws",
      channel: "plain",
      onMessage: (message, connection) => {
        void connection.hub.broadcast("plain", { echo: message });
      },
    });

    await listen(server);

    const sender = await connect(port(server), "/ws");
    const receiver = await connect(port(server), "/ws");

    // Give both joins time to land before broadcasting.
    await waitFor(() => hub.channelCount("plain") === 2);

    sender.socket.send(JSON.stringify({ type: "ping" }));

    const echoed = await Promise.all([sender.firstMessage, receiver.firstMessage]);

    expect(decodeMessage(echoed[0])).toEqual({ echo: { type: "ping" } });
    expect(decodeMessage(echoed[1])).toEqual({ echo: { type: "ping" } });

    // A plain HTTP request on the same server still works.
    const response = await fetch(`http://127.0.0.1:${port(server)}/`);
    expect((await response.json()).ok).toBe(true);

    sender.socket.close();
    receiver.socket.close();

    const upgradesBefore = server.listenerCount("upgrade");
    await attached.close();
    expect(server.listenerCount("upgrade")).toBe(upgradesBefore - 1);
    await attached.close();
    expect(server.listenerCount("upgrade")).toBe(upgradesBefore - 1);

    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("destroys upgrades outside the configured path", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });
    const server = createServer();
    const attached = await attachWebSocketAdapter(server, { hub, path: "/ws" });

    await listen(server);

    await expect(connect(port(server), "/nope")).rejects.toThrow();
    expect(hub.channelCount("default")).toBe(0);

    await attached.close();
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("drives an existing ws server without closing it", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    });

    const attached = await attachWebSocketAdapter(server, {
      hub,
      channel: "shared",
      server: wss as unknown as Parameters<typeof attachWebSocketAdapter>[1]["server"],
    });

    await listen(server);

    const client = await connect(port(server), "/anything");
    await waitFor(() => hub.channelCount("shared") === 1);

    await attached.close();

    // The caller's server is untouched: it still accepts connections.
    expect(wss.options.noServer).toBe(true);
    client.socket.terminate();

    hub.close();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses a second adapter on the same server", async () => {
    // Two upgrade handlers on one server is silent connection loss: both run, the
    // first consumes the socket, and the second never sees a connection with
    // nothing reported anywhere. It has to be an error at attach time.
    const hub = await createRealtimeHub({ heartbeat: false });
    const server = createServer();
    const attached = await attachWebSocketAdapter(server, { hub });

    await expect(attachWebSocketAdapter(server, { hub })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(attachWebSocketAdapter(server, { hub })).rejects.toThrow(
      /already has a realtime adapter attached/,
    );

    // The claim goes with the adapter, so a fresh one is allowed once it closed.
    await attached.close();

    const replacement = await attachWebSocketAdapter(server, { hub });

    await replacement.close();
    hub.close();
  });

  it("closes idempotently and releases a client that never joined", async () => {
    // Shutdown paths run more than once in practice, and a caller cleaning up by
    // client id must not have to know whether that client ever connected.
    const hub = await createRealtimeHub({ heartbeat: false });
    const server = createServer();
    const attached = await attachWebSocketAdapter(server, { hub });

    await attached.close();
    await expect(attached.close()).resolves.toBeUndefined();

    const standalone = createConnectionAdapter({ hub });

    await expect(standalone.release("never-joined")).resolves.toBeUndefined();
    expect(standalone.size).toBe(0);

    hub.close();
  });

  it("requires a hub or an adapter", async () => {
    await expect(
      attachWebSocketAdapter(createServer(), {} as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("refuses an unauthenticated peer before completing the handshake", async () => {
    let calls = 0;
    const hub = await createRealtimeHub({
      heartbeat: false,
      authenticate: ({ request }) => {
        calls += 1;
        const url = new URL((request as { url?: string })?.url ?? "/", "http://localhost");

        if (url.searchParams.get("token") !== "secret") {
          throw new Error("invalid token");
        }

        return { user: url.searchParams.get("user") };
      },
    });
    const server = createServer();
    const attached = await attachWebSocketAdapter(server, { hub, channel: "lobby" });

    await listen(server);

    const refused = new WebSocket(`ws://127.0.0.1:${port(server)}/ws?token=wrong`);
    const message = await new Promise<string>((resolve) => {
      refused.on("open", () => resolve("opened"));
      refused.on("error", (error: Error) => resolve(error.message));
    });

    // Refused with a plain HTTP error, so the peer never holds an open socket.
    expect(message).toContain("401");
    expect(hub.clientCount()).toBe(0);
    expect(adapterSockets(attached)).toBe(0);

    const accepted = await connect(port(server), "/ws?token=secret&user=alice");
    await waitFor(() => hub.channelCount("lobby") === 1);

    // The hook ran once per upgrade: preflight resolved it and `attach` reused
    // the metadata instead of asking the hook twice.
    expect(calls).toBe(2);
    expect(hub.participants("lobby")[0]?.metadata).toEqual({ user: "alice" });

    accepted.socket.terminate();

    await attached.close();
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers an upgrade with 503 once the hub is closed", async () => {
    const hub = await createRealtimeHub({ heartbeat: false });
    const server = createServer();
    const attached = await attachWebSocketAdapter(server, { hub });

    await listen(server);
    hub.close();

    const refused = new WebSocket(`ws://127.0.0.1:${port(server)}/ws`);
    const message = await new Promise<string>((resolve) => {
      refused.on("open", () => resolve("opened"));
      refused.on("error", (error: Error) => resolve(error.message));
    });

    expect(message).toContain("503");

    await attached.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reuses preflight metadata and skips the second authentication", async () => {
    let calls = 0;
    const hub = await createRealtimeHub({
      heartbeat: false,
      authenticate: () => {
        calls += 1;
        return { via: "hook" };
      },
    });
    const adapter = createConnectionAdapter({ hub, channel: "lobby" });
    const connection = makeConnection();

    const metadata = await adapter.authenticate(connection);

    expect(metadata).toEqual({ via: "hook" });
    expect(calls).toBe(1);

    const client = await adapter.attach(connection, undefined, metadata ?? undefined);

    expect(client?.metadata).toEqual({ via: "hook" });
    expect(calls).toBe(1);

    // Without the shortcut the hook runs again for the same socket.
    await adapter.release(client?.id as string);
    expect(await adapter.attach(makeConnection())).not.toBeNull();
    expect(calls).toBe(2);

    hub.close();
  });
});

function adapterSockets(attached: { adapter: ConnectionAdapter }): number {
  return attached.adapter.size;
}

describe("matchesPath", () => {
  it("matches the path itself and its children", () => {
    expect(matchesPath("/ws", "/ws")).toBe(true);
    expect(matchesPath("/ws/chat", "/ws")).toBe(true);
    expect(matchesPath("/ws/chat?token=1", "/ws")).toBe(true);
    expect(matchesPath("/ws/", "/ws/")).toBe(true);
  });

  it("does not match unrelated or prefixed paths", () => {
    expect(matchesPath("/wsx", "/ws")).toBe(false);
    expect(matchesPath("/api/ws", "/ws")).toBe(false);
    expect(matchesPath(undefined, "/ws")).toBe(false);
  });

  it("treats a root path as the root only", () => {
    // A trailing slash must not turn "/" into a prefix that claims every path.
    expect(matchesPath("/", "/")).toBe(true);
    expect(matchesPath("/chat", "/")).toBe(false);
    expect(matchesPath("/chat?token=1", "/")).toBe(false);
  });
});

function port(server: ReturnType<typeof createServer>): number {
  return (server.address() as AddressInfo).port;
}

interface Client {
  socket: WebSocket;
  firstMessage: Promise<Buffer>;
}

/** Listeners are attached before `open`, because `ws` can deliver a frame in the same tick. */
async function connect(portNumber: number, pathname: string): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${portNumber}${pathname}`);
  const firstMessage = new Promise<Buffer>((resolve, reject) => {
    socket.on("message", (data) => resolve(data as Buffer));
    socket.on("error", reject);
  });

  // Created eagerly, so a test that only wants a connection must not turn a late
  // socket error into an unhandled rejection when it tears the socket down.
  firstMessage.catch(() => {});

  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });

  return { socket, firstMessage };
}

async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const startedAt = Date.now();

  await new Promise<void>((resolve, reject) => {
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