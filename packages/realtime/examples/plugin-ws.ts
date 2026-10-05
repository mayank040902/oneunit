import Fastify from "fastify";
import { registerRealtime } from "../src/index.js";

// Fastify with the native `ws` library instead of @fastify/websocket.
//
// Shows `websocketLibrary: "ws"`: this module owns the HTTP upgrade, so it also
// owns the refusal. Authentication runs *before* the handshake, so a peer with a
// bad token gets an HTTP 401 and never holds an open socket — the difference
// from `websocketLibrary: "fastify"`, where @fastify/websocket completes the
// handshake first and the refusal arrives as a 1008 close.
//
// Every connection joins one configured channel and every frame is routed through
// `onMessage`. The example does not interpret the payload: it forwards whatever
// clients send, so the hub stays domain agnostic.

const port = Number(process.env.PORT ?? 3003);
const path = process.env.WS_PATH ?? "/ws";
const channel = "telemetry";
const maxPayload = 8 * 1024;
// Unset means "no token required", which keeps `curl`-style exploration easy.
const token = process.env.WS_TOKEN;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

const hub = await registerRealtime(app, {
  websocketLibrary: "ws",
  path,
  channel,
  maxPayload,
  heartbeatInterval: 15_000,
  limits: { maxClientsPerChannel: 50, maxMessageSize: maxPayload },
  authenticate: token
    ? ({ request }) => {
        const url = new URL((request as { url?: string })?.url ?? "/", "http://localhost");

        if (url.searchParams.get("token") !== token) {
          // Refused before the handshake completes: the peer sees 401, never a
          // socket, and never becomes a channel member.
          throw new Error("invalid token");
        }

        return { user: url.searchParams.get("user") ?? "anonymous" };
      }
    : undefined,
  logger: app.log,
  onConnection: (connection) => {
    // The hub already joined this client to `channel` and reports the current
    // member count. Application-specific state belongs here, not in the hub.
    app.log.info(
      { clientId: connection.clientId, user: connection.metadata.user },
      "client joined",
    );
  },
  onMessage: (message, connection) => {
    // Fan the frame out to the channel the connection actually joined, rather
    // than a name captured at startup, so the two can never drift apart.
    void connection.hub.broadcast(connection.channel, {
      type: "telemetry",
      payload: message,
    });
  },
});

app.get("/health", async () => ({
  ok: true,
  stats: hub.stats(),
}));

await app.listen({ port, host: "0.0.0.0" });

app.log.info(`WebSocket: ws://localhost:${port}${path}${token ? "?token=secret" : ""}`);
app.log.info(`channel:    ${channel} (maxPayload ${maxPayload} bytes)`);
app.log.info("heartbeat:  every 15s, a peer that stops answering is closed");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // The plugin's shutdown hook terminates sockets, detaches the upgrade
    // listener, closes the `ws` server it created and stops the heartbeat.
    void app.close().then(() => process.exit(0));
  });
}