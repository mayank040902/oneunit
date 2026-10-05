import Fastify from "fastify";
import {
  AuthenticationError,
  AuthorizationError,
  decodeMessage,
  registerRealtime,
  type Connection,
} from "../src/index.js";

// Fastify integration with custom `websocket` routes.
//
// Shows: `attachConnections: false` so each route owns admission, the
// `authenticate` hook called explicitly, authorization per join, typed errors and
// a health endpoint reporting hub stats. Nothing here is realtime-specific: a
// channel is just a name, and the rules about who may join one belong to the
// application.

const port = Number(process.env.PORT ?? 3002);
const maxPayload = 64 * 1024;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

const hub = await registerRealtime(app, {
  // Every accepted socket is joined and routed for you. This example defines its
  // own routes, so it opts out and admits clients itself below.
  attachConnections: false,
  maxPayload,
  // Authentication is a hook: return the metadata to attach, or throw to refuse.
  // The hub knows nothing about tokens, names or roles.
  //
  // A transport calls this automatically. With `attachConnections: false` there
  // is no transport-driven admission, so the route calls it explicitly — which is
  // also the answer to "how do I authenticate my own `websocket` routes?".
  authenticate: ({ request }) => {
    const url = new URL((request as { url?: string })?.url ?? "/", "http://localhost");
    const name = url.searchParams.get("name");

    // A real app verifies a signed token here and throws when it is missing,
    // invalid or expired. A throw becomes `AuthenticationError`, so the refusal
    // is a typed error rather than a log line.
    if (!name) {
      throw new Error("missing name");
    }

    return { name };
  },
  // Authorization is a second hook, checked server-side on `connect`, `join`,
  // `send` and `broadcast`. Deny by returning false or throwing.
  //
  // `private:<name>` channels belong to the named client; every other room is
  // open. The channel name is part of the decision, which is why `join` is
  // authorized with the name being joined.
  authorize: ({ action, channel, client }) => {
    if (action !== "join" || !channel?.startsWith("private:")) {
      return true;
    }

    return client?.metadata.name === channel.slice("private:".length);
  },
  logger: app.log,
});

app.get("/ws/chat", { websocket: true }, async (socket, request) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const room = (url.searchParams.get("room") ?? "general").slice(0, 64);
  const connection = socket as unknown as Connection;

  let client;

  try {
    // Authenticate first, then join with the resulting metadata. A refused peer
    // never becomes a channel member, so it costs no slot, no heartbeat and no
    // key.
    const metadata = await hub.authenticate({ connection, request });

    client = await hub.join(room, { connection, metadata });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      socket.close(1008, "authentication required");
      return;
    }

    if (error instanceof AuthorizationError) {
      socket.close(1008, "not allowed in this room");
      return;
    }

    throw error;
  }

  const name = String(client.metadata.name);

  await hub.send(client, {
    type: "welcome",
    room,
    name,
    clientId: client.id,
    members: hub.channelCount(room),
  });

  await hub.broadcast(
    room,
    { type: "presence", event: "joined", name },
    { exclude: [client.id] },
  );

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    void (async () => {
      // `decodeMessage()` is the counterpart of the hub's encoder. The second
      // argument is the transport's `isBinary` flag and it is not optional in
      // practice: the hub sends binary notepack, while a client is free to send
      // JSON text, and the wrong decoder throws "trailing bytes".
      const frame = decodeMessage(data, isBinary) as { type?: string; text?: unknown };
      const type = typeof frame === "object" ? frame?.type : undefined;

      if (type !== "message") {
        await hub.send(client, { type: "error", message: "unknown message type" });
        return;
      }

      // Broadcast to the whole room, sender included, so one client can watch a
      // full round trip. `exclude` skips ids when that is not wanted.
      await hub.broadcast(room, {
        type: "message",
        from: client.id,
        name,
        text: frame.text,
      });
    })().catch((error: unknown) => {
      app.log.error({ err: error, clientId: client.id }, "chat frame failed");
    });
  });

  // A closed socket removes the client from every channel it joined.
  socket.on("close", () => {
    void hub.disconnect(client.id);
  });
});

app.get("/health", async () => ({
  ok: true,
  stats: hub.stats(),
}));

await app.listen({ port, host: "0.0.0.0" });

app.log.info(`WebSocket: ws://localhost:${port}/ws/chat?room=general&name=alice`);
app.log.info("Refused:    ws://localhost:%d/ws/chat?room=general (no name -> 1008)", port);
app.log.info("Private:    ws://localhost:%d/ws/chat?room=private:alice&name=alice", port);
app.log.info(`HTTP:       http://localhost:${port}/health`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // `app.close()` runs the plugin's shutdown hook, which closes the hub,
    // terminates live sockets and stops the heartbeat timer.
    void app.close().then(() => process.exit(0));
  });
}