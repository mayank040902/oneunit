import { WebSocket } from "ws";
import {
  computeSharedKey,
  decodeMessage,
  decryptWithSharedKey,
  e2eeReady,
  fromBase64,
  generateKeyPair,
  toBase64,
} from "../src/index.js";

// Client half of the E2EE example.
//
// Run the server first: `npm run example:e2ee`, then this file.
//
// The private key never leaves this process: only the public key is registered,
// and both sides derive a shared secret with the hub's public key. The hub can
// open what it encrypted, so this is confidentiality against a passive observer
// of the wire and against other clients — not against the server itself.
//
// Every server frame goes through `decodeMessage()`, encrypted or not: the hub
// encodes all outbound frames with notepack, so a plain `JSON.parse` would throw
// on a binary frame and silently lose every hello.

const url = process.env.WS_URL ?? `ws://localhost:${process.env.PORT ?? 3005}/ws/secure`;

// libsodium initialises asynchronously, and the helpers throw a named error
// rather than a panic from deep inside the wrapper if you use them too early.
// `registerRealtime()` awaits this on the server side; a client has to do it
// itself.
await e2eeReady();

const socket = new WebSocket(url);
const keys = generateKeyPair();
let hubPublicKey: Buffer | null = null;

const timeout = setTimeout(() => {
  console.error("timed out; start the server with `npm run example:e2ee`");
  socket.terminate();
  process.exit(1);
}, 10_000);

timeout.unref();

let sent = false;

// Sent at most once: both readiness signals can arrive, and a second identical
// message would only add noise to the transcript.
function send(): void {
  if (sent) {
    return;
  }

  sent = true;
  console.log("sending an encrypted message");
  socket.send(JSON.stringify({ type: "message", text: "ciphertext only" }));
}

function sharedKey(): Buffer {
  if (!hubPublicKey) {
    throw new Error("the hub public key has not arrived yet");
  }

  return computeSharedKey(hubPublicKey, keys.privateKey);
}

socket.on("open", () => {
  console.log(`connected to ${url}, waiting for the hub public key`);
});

socket.on("message", (data: Buffer, isBinary: boolean) => {
  const frame = decodeMessage(data, isBinary) as Record<string, unknown>;

  if (frame?.type === "hello") {
    // Validated: a wrong length or a corrupt encoding throws here rather than
    // producing a shared secret that silently never decrypts anything.
    hubPublicKey = fromBase64(String(frame.serverPublicKey));
    console.log(`hub public key received, registering ours (${hubPublicKey.length} bytes)`);
    socket.send(JSON.stringify({ type: "register", publicKey: toBase64(keys.publicKey) }));
    return;
  }

  if (frame?.type === "registered") {
    // Nothing is sent on this frame alone: the peer may not have a key yet, and a
    // broadcast would be delivered to nobody. `ready` says who is, right now.
    console.log(
      `registered: ${String(frame.encryptedPeers)} of ${String(frame.members)} ` +
        "member(s) can be encrypted to",
    );

    if (Array.isArray(frame.ready) && frame.ready.length > 0) {
      send();
    }

    return;
  }

  if (frame?.type === "peer" && typeof frame.clientId === "string") {
    // The server announced that another member now has a key, so there is
    // somebody to encrypt to.
    send();
    return;
  }

  if (frame?.type === "e2ee" && typeof frame.ciphertext === "string") {
    // The wire format is `{ type: "e2ee", ciphertext }` with Base64 ciphertext, so
    // a client can tell an encrypted frame from a plaintext one without guessing.
    const plaintext = decryptWithSharedKey(fromBase64(frame.ciphertext), sharedKey());
    const payload = decodeMessage(plaintext) as { text?: unknown };

    console.log(`decrypted: ${String(payload?.text)}`);
    clearTimeout(timeout);
    socket.close(1000, "round trip complete");
    return;
  }

  if (frame?.type === "sent") {
    console.log(`hub encrypted the frame for ${String(frame.delivered)} recipient(s)`);
    return;
  }

  console.log("frame", frame);
});

socket.on("close", (code, reason) => {
  clearTimeout(timeout);
  console.log(`closed ${code} ${reason.toString()}`);
  process.exit(code === 1000 ? 0 : 1);
});

socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error("socket error", error.message);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    socket.close(1000, signal);
  });
}