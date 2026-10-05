import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { createRealtimeHub, matchesPath, type Connection } from "../src/index.js";

// Horizontal scaling, with no broker inside this package.
//
// The realtime package owns local connections. An external adapter owns
// cross-instance event propagation and calls `broadcast()` on the receiving
// instance. This example wires an HTTP ingest endpoint to a broadcast, which is
// the same seam a Kafka, Redis or NATS consumer would use:
//
//     external adapter  ->  target.broadcast(channel, message)
//                                  |
//                            RealtimeHub
//                                  |
//                        local WebSocket clients
//
// This package never learns which broker sits behind that adapter, and ships
// none. Run two instances against the same adapter and both fan out.

const port = Number(process.env.PORT ?? 3004);
const upgradePath = "/ws/subscribe";
const maxClients = Number(process.env.MAX_CLIENTS ?? 100);

const hub = await createRealtimeHub({
  limits: { maxMessageSize: 32 * 1024, maxClientsPerChannel: maxClients },
  logger: {
    warn: (payload, message) => console.warn(message ?? "", payload),
    error: (payload, message) => console.error(message ?? "", payload),
  },
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
// The transport adapter joins one fixed channel per attachment, while clients
// here pick their own channel from the query string, so this example keeps the
// hub usage explicit. It is the same `Connection` contract either way; see
// `standalone.ts` for the adapter doing the wiring.
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

app.server.on("upgrade", (request, socket, head) => {
  // `matchesPath` is the same matcher the adapter uses, so `/ws/subscribe` and
  // anything below it are ours and nothing else is. An unmatched upgrade is
  // destroyed rather than left dangling, which is what keeps it from leaking a
  // socket the HTTP server is still holding open.
  if (!matchesPath(request.url, upgradePath)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  const channel = (url.searchParams.get("channel") ?? "default").slice(0, 64);
  const connection = ws as unknown as Connection;

  void (async () => {
    const client = await hub.join(channel, { connection });

    await hub.send(client, {
      type: "subscribed",
      channel,
      clientId: client.id,
      members: hub.channelCount(channel),
    });

    ws.on("close", () => {
      void hub.disconnect(client.id);
    });
  })().catch((error: unknown) => {
    console.error("subscribe failed", error);
    ws.close(1013, "subscribe failed");
  });
});

// The external adapter seam. A broker consumer would call exactly this, passing
// whatever payload it consumed. Nothing below this line knows which broker that
// is, and neither does the hub.
const adapter: { broadcast: typeof hub.broadcast } = {
  broadcast: (channelName, message, options) => hub.broadcast(channelName, message, options),
};

app.post<{ Params: { channel: string }; Body: unknown }>(
  "/ingest/:channel",
  async (request) => {
    const delivered = await adapter.broadcast(request.params.channel, request.body, {
      // `source` is recorded on the hub's `broadcast` event for observability. It
      // is never forwarded to clients.
      metadata: { source: "http-ingest", instance: process.env.INSTANCE ?? "local" },
    });

    return { channel: request.params.channel, delivered };
  },
);

app.get("/health", async () => ({ ok: true, stats: hub.stats() }));

await app.listen({ port, host: "0.0.0.0" });

app.log.info(`WebSocket: ws://localhost:${port}${upgradePath}?channel=orders`);
app.log.info(`Ingest:    POST http://localhost:${port}/ingest/<channel>`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // Order matters: terminate the sockets while the HTTP server is still open,
    // then clear hub state, then let Fastify close the server itself.
    hub.close();

    for (const socket of wss.clients) {
      socket.terminate();
    }

    void app.close().then(() => process.exit(0));
  });
}