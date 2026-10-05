import { createServer } from "node:http";
import {
  ChannelError,
  MessageTooLargeError,
  attachWebSocketAdapter,
  createRealtimeHub,
} from "../src/index.js";

// No framework, and no Fastify either.
//
// `attachWebSocketAdapter()` is the whole integration: it turns a `node:http`
// server plus `ws` into hub connections, taking care of authentication, joining,
// message routing and cleanup. The hub itself knows nothing about HTTP, and
// neither does this file's business logic.
//
// Shows: the adapter on a plain Node server, an authentication hook refusing a
// peer before the handshake completes, limits, a shared heartbeat timer,
// `stats()`, and a deterministic shutdown.

const port = Number(process.env.PORT ?? 3001);
const token = process.env.WS_TOKEN ?? "demo-token";
const heartbeatMs = Number(process.env.HEARTBEAT_MS ?? 30_000);

const hub = await createRealtimeHub({
  limits: { maxMessageSize: 64 * 1024, maxClientsPerChannel: 100 },
  backpressure: { maxBufferedBytes: 64 * 1024, maxConsecutiveDrops: 8 },
  heartbeat: { intervalMs: heartbeatMs, timeoutMs: heartbeatMs * 2 },
  // Refuse a peer here and it never becomes a client: no channel member, no
  // connection slot, no heartbeat, no key. This example owns the upgrade, so the
  // handshake waits for this hook and a refused peer is answered with a plain
  // HTTP 401 instead of being handed a socket. Under `@fastify/websocket`, which
  // owns the handshake itself, the refusal arrives as a 1008 close instead.
  authenticate: ({ request }) => {
    const url = new URL((request as { url?: string })?.url ?? "/", "http://localhost");

    if (url.searchParams.get("token") !== token) {
      throw new Error("invalid token");
    }

    return { name: url.searchParams.get("name") ?? "anonymous" };
  },
  // Errors are expected in a realtime process, so they are logged instead of
  // thrown. Nothing is logged unless a logger is passed in.
  logger: {
    debug: (payload, message) => console.debug(message ?? "", payload),
    warn: (payload, message) => console.warn(message ?? "", payload),
    error: (payload, message) => console.error(message ?? "", payload),
  },
});

const server = createServer((_request, response) => {
  response.writeHead(426, { "Content-Type": "text/plain" });
  response.end("This port speaks WebSocket only. Try ws://localhost:3001/ws\n");
});

const realtime = await attachWebSocketAdapter(server, {
  hub,
  path: "/ws",
  maxPayload: 64 * 1024,
  onConnection: async (connection) => {
    await connection.hub.send(connection, {
      type: "welcome",
      clientId: connection.clientId,
      members: connection.hub.channelCount(connection.channel),
    });

    await connection.hub.broadcast(
      connection.channel,
      { type: "presence", event: "joined", clientId: connection.clientId },
      { exclude: [connection.clientId] },
    );
  },
  onMessage: async (message, connection) => {
    // The adapter has already decoded the frame: notepack for binary, JSON for
    // text, with the raw text as a fallback. `onMessage` receives the value, not
    // the bytes.
    const frame = message as { type?: string; text?: unknown };

    if (frame?.type === "flood") {
      // Backpressure demo: frames far larger than `maxBufferedBytes` in a tight
      // loop. A client that cannot keep up starts skipping frames instead of
      // growing this process's memory, and is disconnected if it stays behind,
      // which `stats()` shows.
      const count = Number(frame.text ?? 100);

      for (let index = 0; index < count; index++) {
        await connection.hub.send(connection, {
          type: "flood",
          index,
          payload: "x".repeat(32 * 1024),
        });
      }

      return;
    }

    try {
      await connection.hub.broadcast(
        connection.channel,
        { type: "message", from: connection.clientId, text: frame?.text },
        { exclude: [connection.clientId] },
      );
    } catch (error) {
      // A rejected broadcast is an expected outcome: an oversized frame or an
      // unknown channel. Answer the sender and keep the connection, because the
      // frame was bad, not the peer. The adapter logs anything that escapes.
      if (error instanceof ChannelError || error instanceof MessageTooLargeError) {
        await connection.hub.send(connection, { type: "error", message: error.message });
        return;
      }

      throw error;
    }
  },
});

setInterval(() => {
  console.log("stats", hub.stats());
}, 10_000).unref();

await new Promise<void>((resolve) => {
  server.listen(port, "0.0.0.0", resolve);
});

console.log(`WebSocket: ws://localhost:${port}/ws?token=${token}`);
console.log(`heartbeat: ${heartbeatMs}ms (shared timer, unref'd)`);
console.log('Send {"type":"flood","text":200} to watch backpressure drop frames.');

let closing = false;

const shutdown = async (signal: string): Promise<void> => {
  if (closing) {
    return;
  }

  closing = true;
  console.log(`\n${signal}: closing ${hub.totalSubscribers()} subscriber(s)`);

  // Order matters: the adapter terminates live sockets and detaches the upgrade
  // listener, the hub stops the heartbeat and clears channels, then the HTTP
  // server that accepted them closes.
  await realtime.close();
  hub.close();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}
