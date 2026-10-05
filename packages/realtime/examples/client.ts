import { WebSocket } from "ws";
import { decodeMessage } from "../src/index.js";

// Minimal Node client for `chat.ts`.
//
// Run the server first: `npm run example:chat`, then this file. It is a client,
// so it exits on its own once the round trip is done.
//
// Server frames are notepack-encoded, so `decodeMessage()` is the counterpart of
// the hub's encoder. A browser client cannot import it — the browser `WebSocket`
// API hands you an ArrayBuffer or Blob — and would need the notepack decoder
// instead.

const url =
  process.env.WS_URL ??
  `ws://localhost:${process.env.PORT ?? 3002}/ws/chat?room=general&name=alice`;
const text = process.env.WS_TEXT ?? "hello from node";

const socket = new WebSocket(url);
const timeout = setTimeout(() => {
  console.error("timed out waiting for the server; is example:chat running?");
  socket.terminate();
  process.exit(1);
}, 10_000);

timeout.unref();

// Sent once the connection is open, so one client can observe a whole round trip:
// its own message comes back through the room broadcast.
socket.on("open", () => {
  console.log(`connected to ${url}`);
  socket.send(JSON.stringify({ type: "message", text }));
});

socket.on("message", (data: Buffer, isBinary: boolean) => {
  const frame = decodeMessage(data, isBinary) as { type?: string; [key: string]: unknown };

  switch (frame.type) {
    case "welcome":
      console.log(
        `welcome ${String(frame.name)} in ${String(frame.room)} ` +
          `(${String(frame.members)} online, clientId ${String(frame.clientId)})`,
      );
      break;

    case "presence":
      console.log(`presence: ${String(frame.name)} ${String(frame.event)}`);
      break;

    case "message":
      console.log(`${String(frame.name)}: ${String(frame.text)}`);
      // The room is long-lived, so this example closes once it has seen its own
      // message come back. A real client would keep the socket open and let the
      // heartbeat tell it whether the peer is still alive.
      clearTimeout(timeout);
      socket.close(1000, "round trip complete");
      break;

    case "error":
      // A server-side validation failure, e.g. an unknown message type. The
      // connection stays open: this is a message problem, not a peer problem.
      console.error(`error from server: ${String(frame.message)}`);
      break;

    default:
      console.log("frame", frame);
  }
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