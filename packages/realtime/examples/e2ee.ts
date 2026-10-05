import Fastify from "fastify";
import { decodeMessage, fromBase64, registerRealtime, type Connection } from "../src/index.js";

// End-to-end encryption with libsodium (X25519 + XSalsa20-Poly1305).
//
// The hub holds a key pair, never sees a plaintext payload of an encrypted
// broadcast, and can only open what a client encrypted for it. What the server
// still sees is metadata: which connections exist, which channels they joined,
// when they joined and how much they send. E2EE is not TLS and not anonymity.
//
// Shows: `e2ee: true`, validated per-client key registration, an honest count of
// who can actually be encrypted to, `broadcastEncrypted()` and
// `decryptFromClient()`.

const port = Number(process.env.PORT ?? 3005);
const channel = "secure";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

const hub = await registerRealtime(app, {
  attachConnections: false,
  // Waits for libsodium readiness and generates the hub key pair.
  e2ee: true,
  logger: app.log,
  onEvent: (event) => {
    if (event.name === "drop" || event.name === "reject") {
      app.log.warn({ event }, "realtime");
    }
  },
});

const hubPublicKey = hub.e2eePublicKey;

if (!hubPublicKey) {
  throw new Error("E2EE was requested but no key pair was generated");
}

// Encrypting a throwaway probe is the only public way to ask "can this member be
// encrypted to?". It costs one box seal per member, which is the right trade for
// a diagnostic and the wrong trade for a hot loop — do not do this per message.
const PROBE = new TextEncoder().encode("?");

/** Members this hub can actually encrypt to, excluding one client. */
function readyPeers(exclude: string): string[] {
  return hub
    .participants(channel)
    .filter(
      (member) => member.id !== exclude && hub.encryptForClient(member, PROBE) !== null,
    )
    .map((member) => member.id);
}

app.get("/ws/secure", { websocket: true }, async (socket, _request) => {
  void (async () => {
    const connection = socket as unknown as Connection;
    // A real app authenticates here, the way `chat.ts` does: a peer with no valid
    // token must not become a channel member at all.
    const client = await hub.join(channel, { connection });

    // Step 1: hand the client the hub's public key. It is public by
    // definition; only the hub keeps the private half.
    await hub.send(client, {
      type: "hello",
      clientId: client.id,
      serverPublicKey: hubPublicKey.toString("base64"),
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      void (async () => {
        const frame = decodeMessage(data, isBinary) as {
          type?: string;
          text?: string;
          publicKey?: string;
        };

        if (frame?.type === "register" && typeof frame.publicKey === "string") {
          // Step 2: the client sends its public key. `fromBase64()` validates
          // the encoding and length and throws a named error on bad input, which
          // keeps a malformed key from becoming a silently unusable client.
          // The private half never leaves the client.
          const key = fromBase64(frame.publicKey);

          if (hub.registerClientKey(connection, key) === null) {
            await hub.send(client, { type: "error", message: "E2EE is not enabled" });
            return;
          }

          const ready = readyPeers(client.id);

          // The count is members this hub can actually encrypt to, not members in
          // the room. A peer that never registered is not an encrypted peer.
          await hub.send(client, {
            type: "registered",
            encryptedPeers: ready.length,
            members: hub.channelCount(channel),
            ready,
          });

          // A client cannot encrypt for a peer that has no key yet, so nobody can
          // send anything until both sides have registered. Both directions are
          // needed: the newcomer is told who is already ready, and everyone else
          // is told the newcomer is ready. Announcing only one side deadlocks two
          // clients that connect at the same moment.
          await hub.broadcast(
            channel,
            { type: "peer", clientId: client.id },
            { exclude: [client.id] },
          );
          return;
        }

        if (frame?.type === "message") {
          // Step 3: encrypt per recipient, because each recipient has a
          // different shared key. Members that never registered a key are
          // skipped rather than receiving plaintext — `delivered` is the honest
          // number of ciphertexts written.
          const delivered = await hub.broadcastEncrypted(
            channel,
            { type: "message", from: client.id, text: frame.text },
            { exclude: [client.id] },
          );

          await hub.send(client, { type: "sent", delivered });
          return;
        }

        if (frame?.type === "secure" && typeof frame.text === "string") {
          // Incoming direction: a client may hand the hub a ciphertext it
          // produced with the shared key. `decryptFromClient()` returns null
          // rather than throwing on a wrong key or a corrupt frame.
          const plaintext = hub.decryptFromClient(connection, fromBase64(frame.text));

          await hub.send(client, {
            type: "secure-reply",
            opened:
              plaintext === null
                ? null
                : (decodeMessage(plaintext) as { text?: unknown }),
          });
          return;
        }

        await hub.send(client, { type: "error", message: "unknown frame type" });
      })().catch((error: unknown) => {
        app.log.error({ err: error, clientId: client.id }, "secure frame failed");
      });
    });

    socket.on("close", () => {
      // Dropping the client also releases its E2EE key: keys live in a WeakMap
      // keyed by the connection, so a closed socket cannot leave one behind.
      void hub.disconnect(client.id);
    });
  })().catch((error: unknown) => {
    app.log.error({ err: error }, "secure join failed");
    socket.close(1013, "join failed");
  });
});

await app.listen({ port, host: "0.0.0.0" });

app.log.info(`WebSocket: ws://localhost:${port}/ws/secure`);
app.log.info("Client:     npm run example:e2ee-client");
app.log.info("Limitations: the server still sees channels, membership and volume.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}