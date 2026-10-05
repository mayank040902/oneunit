import { describe, it, expect, vi } from "vitest";
import { decode, encode } from "notepack.io";
import sodium from "libsodium-wrappers";
import {
  computeSharedKey,
  decryptWithSharedKey,
  generateKeyPair,
  toBase64,
} from "../src/e2ee.js";
import {
  AuthorizationError,
  AuthenticationError,
  ChannelError,
  ConnectionClosedError,
  ConnectionError,
  ConnectionLimitError,
  MessageTooLargeError,
} from "../src/errors.js";
import {
  RealtimeHub,
  createRealtimeHub,
  decodeMessage,
  type Client,
  type RealtimeEvent,
} from "../src/hub.js";

await sodium.ready;

interface FakeConnection {
  id: string;
  readyState: number;
  bufferedAmount: number;
  pings: number;
  terminations: number;
  closed: { code?: number; reason?: string } | null;
  _messages: unknown[];
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
}

function makeConnection(id: string, overrides: Partial<FakeConnection> = {}): FakeConnection {
  const connection: FakeConnection = {
    id,
    readyState: 1,
    bufferedAmount: 0,
    pings: 0,
    terminations: 0,
    closed: null,
    _messages: [],
    send(data: Uint8Array) {
      // notepack frames decode; a raw string frame is kept verbatim.
      try {
        connection._messages.push(decode(data));
      } catch {
        connection._messages.push(Buffer.from(data).toString("utf8"));
      }
    },
    close(code?: number, reason?: string) {
      connection.closed = { code, reason };
      connection.readyState = 3;
    },
    terminate() {
      connection.terminations += 1;
      connection.readyState = 3;
    },
    ping() {
      connection.pings += 1;
    },
    ...overrides,
  };

  return connection;
}

function frames(connection: FakeConnection): unknown[] {
  return connection._messages;
}

function firstFrame(connection: FakeConnection): Record<string, unknown> {
  return connection._messages[0] as Record<string, unknown>;
}

async function joined(
  hub: RealtimeHub,
  channel: string,
  connection: FakeConnection,
  id = connection.id,
): Promise<Client> {
  return hub.join(channel, { id, connection });
}

describe("decodeMessage", () => {
  it("decodes a binary notepack frame by default", () => {
    // The hub encodes everything it sends as binary notepack, so this is the
    // default a client relies on.
    const frame = encode({ type: "welcome", members: 2 });

    expect(decodeMessage(frame)).toEqual({ type: "welcome", members: 2 });
    expect(decodeMessage(frame, true)).toEqual({ type: "welcome", members: 2 });
    expect(decodeMessage(Buffer.from(frame))).toEqual({ type: "welcome", members: 2 });
  });

  it("reads a text frame as JSON when the transport says it is not binary", () => {
    // Handing a JSON text frame to the notepack decoder throws "trailing bytes",
    // which is a confusing way to learn that `isBinary` was dropped.
    const text = Buffer.from('{"type":"message","text":"hello"}', "utf8");

    expect(decodeMessage(text, false)).toEqual({ type: "message", text: "hello" });
    expect(() => decodeMessage(text)).toThrow();
  });

  it("returns unparseable text as-is rather than throwing", () => {
    expect(decodeMessage(Buffer.from("not json", "utf8"), false)).toBe("not json");
    expect(decodeMessage("{broken", false)).toBe("{broken");
  });

  it("reads a string frame as JSON", () => {
    // A string can only come from a text frame, so the flag cannot contradict it.
    expect(decodeMessage('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(decodeMessage("plain", false)).toBe("plain");
  });

  it("accepts a bare Uint8Array without copying it into a Buffer first", () => {
    const bytes = new Uint8Array(encode({ type: "ping" }));

    expect(decodeMessage(bytes)).toEqual({ type: "ping" });
    expect(decodeMessage(new Uint8Array(Buffer.from('{"a":1}', "utf8")), false)).toEqual({
      a: 1,
    });
  });
});

describe("RealtimeHub membership", () => {
  it("join adds a client to a channel", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");
    const client = await joined(hub, "room-1", connection);

    expect(hub.channelCount("room-1")).toBe(1);
    expect(hub.hasChannel("room-1")).toBe(true);
    expect(hub.channelNames()).toEqual(["room-1"]);
    expect(hub.clientCount()).toBe(1);
    expect(hub.participants("room-1")).toHaveLength(1);
    expect(client.id).toBe("c1");
    expect(client.channels.has("room-1")).toBe(true);
  });

  it("duplicate joins are idempotent", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    const first = await joined(hub, "room-1", connection);
    const second = await joined(hub, "room-1", connection);

    expect(first.id).toBe(second.id);
    expect(hub.channelCount("room-1")).toBe(1);
    expect(hub.clientCount()).toBe(1);
    expect(hub.totalSubscribers()).toBe(1);
  });

  it("a second connection cannot hijack a taken client id", async () => {
    const hub = new RealtimeHub({ heartbeat: false });

    await joined(hub, "room-1", makeConnection("c1"));

    await expect(
      joined(hub, "room-1", makeConnection("c2"), "c1"),
    ).rejects.toBeInstanceOf(ConnectionError);
  });

  it("leave removes a client and cleans empty channels", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    expect(await hub.leave("room-1", "c1")).toBe(true);

    expect(hub.channelCount("room-1")).toBe(0);
    expect(hub.hasChannel("room-1")).toBe(false);
    expect(hub.participants("room-1")).toEqual([]);
  });

  it("leave on an unknown channel or client is a safe no-op", async () => {
    const hub = new RealtimeHub({ heartbeat: false });

    await joined(hub, "room-1", makeConnection("c1"));

    expect(await hub.leave("nonexistent", "c1")).toBe(false);
    expect(await hub.leave("room-1", "unknown")).toBe(false);
    expect(await hub.leave("", "c1")).toBe(false);
    expect(hub.channelCount("room-1")).toBe(1);
  });

  it("keeps a client that still belongs to another channel", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    await joined(hub, "room-2", connection);

    await hub.leave("room-1", "c1");

    expect(hub.hasClient("c1")).toBe(true);
    expect(hub.channelsFor("c1")).toEqual(["room-2"]);
    expect(hub.totalSubscribers()).toBe(1);
  });

  it("disconnect clears every channel, the client and its connection", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    await joined(hub, "room-2", connection);

    expect(await hub.disconnect("c1")).toBe(true);
    expect(await hub.disconnect("c1")).toBe(false);

    expect(hub.hasClient("c1")).toBe(false);
    expect(hub.channelsFor("c1")).toEqual([]);
    expect(hub.channelNames()).toEqual([]);
    expect(hub.clientCount()).toBe(0);
    expect(hub.totalSubscribers()).toBe(0);
    expect(connection.closed).toEqual({ code: 1000, reason: "Client disconnected" });
  });

  it("does not expose internal state mutably", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    const client = await joined(hub, "room-1", connection, "c1");

    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.metadata)).toBe(true);

    const participants = hub.participants("room-1");
    const channelsOfFirst = participants[0]?.channels as Set<string>;
    participants.length = 0;
    channelsOfFirst.add("injected");

    expect(hub.channelCount("room-1")).toBe(1);
    expect(hub.channelsFor("c1")).toEqual(["room-1"]);
    expect((hub as unknown as { channels: Map<string, unknown> }).channels.size).toBe(1);
  });
});

describe("RealtimeHub delivery", () => {
  it("broadcast reaches every member", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const first = makeConnection("c1");
    const second = makeConnection("c2");

    await joined(hub, "room-1", first);
    await joined(hub, "room-1", second);

    expect(await hub.broadcast("room-1", { type: "hello" })).toBe(2);
    expect(frames(first)).toEqual([{ type: "hello" }]);
    expect(frames(second)).toEqual([{ type: "hello" }]);
  });

  it("broadcast skips closed connections and unknown channels", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const open = makeConnection("c1");
    const closed = makeConnection("c2");

    await joined(hub, "room-1", open);
    await joined(hub, "room-1", closed);

    // The transport closed after the client joined.
    closed.readyState = 3;

    expect(await hub.broadcast("room-1", { type: "hello" })).toBe(1);
    expect(await hub.broadcast("empty", { type: "hello" })).toBe(0);
    expect(frames(closed)).toHaveLength(0);
  });

  it("broadcast honours include and exclude filters", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const first = makeConnection("c1");
    const second = makeConnection("c2");
    const third = makeConnection("c3");

    await joined(hub, "room-1", first);
    await joined(hub, "room-1", second);
    await joined(hub, "room-1", third);

    expect(await hub.broadcast("room-1", "hi", { exclude: ["c1"] })).toBe(2);
    expect(await hub.broadcast("room-1", "hi", { include: ["c3"] })).toBe(1);

    expect(frames(first)).toHaveLength(0);
    expect(frames(second)).toHaveLength(1);
    expect(frames(third)).toHaveLength(2);
  });

  it("send delivers to a single connection or client", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    const client = hub.client("c1");

    expect(await hub.send(connection, { type: "pong" })).toBe(true);
    expect(await hub.send(client as Client, { type: "pong2" })).toBe(true);
    expect(frames(connection)).toEqual([{ type: "pong" }, { type: "pong2" }]);
  });

  it("send passes text through without wrapping", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const received: string[] = [];
    const connection = makeConnection("c1", {
      send(data: Uint8Array) {
        received.push(Buffer.from(data).toString("utf8"));
      },
    });

    await joined(hub, "room-1", connection);
    expect(await hub.send(connection, "plain text")).toBe(true);
    expect(received).toEqual(["plain text"]);
  });

  it("raw frames are forwarded untouched", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const sink: Buffer[] = [];
    const connection = makeConnection("c1", {
      send(data: Uint8Array) {
        sink.push(Buffer.from(data));
      },
    });

    await joined(hub, "room", connection);
    const frame = Buffer.from('{"type":"raw"}');

    expect(await hub.broadcastRaw("room", frame)).toBe(1);
    expect(sink).toEqual([frame]);
    expect(await hub.sendRaw(connection, frame)).toBe(true);
    expect(await hub.broadcastRaw("missing", frame)).toBe(0);
  });

  it("one failing send never breaks the rest of a broadcast", async () => {
    const broken = makeConnection("c1", {
      send() {
        throw new Error("socket is gone");
      },
    });
    const healthy = makeConnection("c2");
    const events: RealtimeEvent[] = [];
    const hub = new RealtimeHub({
      heartbeat: false,
      onEvent: (event) => events.push(event),
    });

    await joined(hub, "room-1", broken);
    await joined(hub, "room-1", healthy);

    expect(await hub.broadcast("room-1", { type: "hello" })).toBe(1);
    expect(frames(healthy)).toEqual([{ type: "hello" }]);
    expect(broken.terminations).toBe(1);
    expect(hub.hasClient("c1")).toBe(false);
    expect(hub.channelCount("room-1")).toBe(1);

    const stats = hub.stats();
    expect(stats.messagesSent).toBe(1);
    expect(stats.sendFailures).toBe(1);
    expect(stats.messagesDropped).toBe(1);
    expect(stats.broadcasts).toBe(1);
    expect(events.some((event) => event.reason === "send-failed")).toBe(true);
  });

  it("reports delivery events for monitoring", async () => {
    const events: RealtimeEvent[] = [];
    const hub = new RealtimeHub({
      heartbeat: false,
      onEvent: (event) => events.push(event),
    });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    await hub.broadcast("room-1", { type: "hello" }, { metadata: { source: "test" } });

    expect(events.map((event) => event.name)).toEqual([
      "connect",
      "join",
      "send",
      "broadcast",
    ]);
    expect(events.at(-1)?.metadata).toEqual({ source: "test" });
    expect(events[0].at).toBeTypeOf("number");
  });
});

describe("RealtimeHub errors and limits", () => {
  it("rejects invalid channel names", async () => {
    const hub = new RealtimeHub({ heartbeat: false, limits: { maxChannelNameLength: 8 } });
    const connection = makeConnection("c1");

    await expect(joined(hub, "", connection)).rejects.toBeInstanceOf(ChannelError);
    await expect(joined(hub, "   ", connection)).rejects.toBeInstanceOf(ChannelError);
    await expect(joined(hub, "too-long-channel", connection)).rejects.toBeInstanceOf(
      ChannelError,
    );
    await expect(joined(hub, "badname", connection)).rejects.toBeInstanceOf(
      ChannelError,
    );
    await expect(
      hub.join(undefined as unknown as string, connection),
    ).rejects.toBeInstanceOf(ChannelError);
    expect(hub.channelCount("too-long-channel")).toBe(0);
  });

  it("rejects oversized messages before touching a connection", async () => {
    const hub = new RealtimeHub({ heartbeat: false, limits: { maxMessageSize: 32 } });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);

    await expect(hub.broadcast("room-1", "x".repeat(64))).rejects.toBeInstanceOf(
      MessageTooLargeError,
    );
    await expect(hub.send(connection, "x".repeat(64))).rejects.toBeInstanceOf(
      MessageTooLargeError,
    );
    await expect(
      hub.sendRaw(connection, Buffer.alloc(64)),
    ).rejects.toBeInstanceOf(MessageTooLargeError);

    expect(frames(connection)).toHaveLength(0);
    expect(hub.stats().messagesSent).toBe(0);
  });

  it("rejects connections past the connection limit", async () => {
    const hub = new RealtimeHub({
      heartbeat: false,
      limits: { maxConnections: 1 },
    });

    await joined(hub, "room-1", makeConnection("c1"));

    await expect(joined(hub, "room-1", makeConnection("c2"))).rejects.toBeInstanceOf(
      ConnectionLimitError,
    );
    await expect(joined(hub, "room-2", makeConnection("c2"))).rejects.toBeInstanceOf(
      ConnectionLimitError,
    );

    expect(hub.stats().connectionsRejected).toBe(2);
    expect(hub.clientCount()).toBe(1);
    expect(hub.channelCount("room-2")).toBe(0);
  });

  it("rejects channel memberships past their limits", async () => {
    const hub = new RealtimeHub({
      heartbeat: false,
      limits: { maxClientsPerChannel: 1, maxChannelsPerClient: 1 },
    });
    const first = makeConnection("c1");

    await joined(hub, "room-1", first);

    await expect(joined(hub, "room-1", makeConnection("c2"))).rejects.toBeInstanceOf(
      ConnectionLimitError,
    );
    await expect(joined(hub, "room-2", first)).rejects.toBeInstanceOf(
      ConnectionLimitError,
    );

    expect(hub.clientCount()).toBe(1);
    expect(hub.channelCount("room-1")).toBe(1);
    expect(hub.channelCount("room-2")).toBe(0);
  });

  it("refuses joins on a connection that is not open", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1", { readyState: 3 });

    await expect(joined(hub, "room-1", connection)).rejects.toBeInstanceOf(
      ConnectionError,
    );
    await expect(hub.join("room-1", {} as never)).rejects.toBeInstanceOf(ConnectionError);
    expect(hub.clientCount()).toBe(0);
  });

  it("survives an onEvent hook that throws", async () => {
    const hub = new RealtimeHub({
      heartbeat: false,
      onEvent: () => {
        throw new Error("metrics exploded");
      },
    });

    await joined(hub, "room-1", makeConnection("c1"));
    expect(await hub.broadcast("room-1", "hi")).toBe(1);
  });

  it("validates configured limits", () => {
    expect(() => new RealtimeHub({ limits: { maxMessageSize: 0 } })).toThrow(TypeError);
    expect(() => new RealtimeHub({ backpressure: { maxConsecutiveDrops: -1 } })).toThrow(
      TypeError,
    );
    expect(() => new RealtimeHub({ heartbeat: { intervalMs: 0 } })).toThrow(TypeError);
  });
});

describe("RealtimeHub authentication and authorization", () => {
  it("attaches metadata returned by the authentication hook", async () => {
    const hub = new RealtimeHub({
      heartbeat: false,
      authenticate: ({ request }) => ({ token: (request as { token?: string })?.token }),
    });
    const connection = makeConnection("c1");

    const metadata = await hub.authenticate({ connection, request: { token: "abc" } });
    const client = await hub.join("room-1", { id: "c1", connection, metadata });

    expect(client.metadata).toEqual({ token: "abc" });
    expect(hub.client("c1")?.metadata.token).toBe("abc");

    expect(hub.attachMetadata("c1", { role: "admin" })).toBe(true);
    expect(hub.client("c1")?.metadata).toEqual({ token: "abc", role: "admin" });
    expect(hub.attachMetadata("unknown", { role: "admin" })).toBe(false);
  });

  it("rejects a connection when the authentication hook throws", async () => {
    const hub = new RealtimeHub({
      heartbeat: false,
      authenticate: () => {
        throw new Error("bad token");
      },
    });

    await expect(hub.authenticate({ connection: makeConnection("c1") })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(hub.stats().connectionsRejected).toBe(1);
  });

  it("denies join when the authorize hook refuses", async () => {
    const hub = new RealtimeHub({
      heartbeat: false,
      authorize: ({ action, channel }) => !(action === "join" && channel === "locked"),
    });

    await expect(joined(hub, "locked", makeConnection("c1"))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(hub.channelCount("locked")).toBe(0);
    expect(hub.clientCount()).toBe(0);

    await joined(hub, "open", makeConnection("c2"));
    expect(hub.channelCount("open")).toBe(1);
    expect(hub.stats().authorizationsDenied).toBe(1);
  });

  it("authorizes connect, send and broadcast independently", async () => {
    const calls: string[] = [];
    const hub = new RealtimeHub({
      heartbeat: false,
      authorize: ({ action, channel }) => {
        calls.push(channel ? `${action}:${channel}` : action);
        return action !== "send";
      },
    });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);

    await expect(hub.send(connection, "hi")).rejects.toBeInstanceOf(AuthorizationError);
    expect(await hub.broadcast("room-1", "hi")).toBe(1);

    expect(calls).toEqual(["connect", "join:room-1", "send", "broadcast:room-1"]);
  });

  it("treats a throwing authorize hook as a denial", async () => {
    const hub = new RealtimeHub({
      heartbeat: false,
      authorize: () => {
        throw new Error("policy service down");
      },
    });

    await expect(joined(hub, "room-1", makeConnection("c1"))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("can authorize every recipient of a broadcast", async () => {
    const allowed = new Set(["c1"]);
    const hub = new RealtimeHub({
      heartbeat: false,
      authorize: ({ action, client }) => (action === "send" ? allowed.has(client?.id ?? "") : true),
    });

    await joined(hub, "room-1", makeConnection("c1"));
    await joined(hub, "room-1", makeConnection("c2"));

    expect(await hub.broadcast("room-1", "hi")).toBe(2);
    expect(await hub.broadcast("room-1", "hi", { authorizeRecipients: true })).toBe(1);
  });
});

describe("RealtimeHub backpressure", () => {
  it("skips writes to a connection above the buffered limit", async () => {
    const slow = makeConnection("c1", { bufferedAmount: 4096 });
    const hub = new RealtimeHub({
      heartbeat: false,
      backpressure: { maxBufferedBytes: 64, maxConsecutiveDrops: 32 },
    });

    await joined(hub, "room-1", slow);

    expect(await hub.broadcast("room-1", { type: "hello" })).toBe(0);
    expect(frames(slow)).toHaveLength(0);
    expect(slow.terminations).toBe(0);
    expect(hub.stats().messagesDropped).toBe(1);
    expect(hub.hasClient("c1")).toBe(true);
  });

  it("terminates a connection that stays above the limit", async () => {
    const slow = makeConnection("c1", { bufferedAmount: 4096 });
    const hub = new RealtimeHub({
      heartbeat: false,
      backpressure: { maxBufferedBytes: 64, maxConsecutiveDrops: 2 },
    });

    await joined(hub, "room-1", slow);
    await hub.broadcast("room-1", "hi");
    await hub.broadcast("room-1", "hi");

    expect(slow.closed?.code).toBe(1013);
    expect(hub.hasClient("c1")).toBe(false);
    expect(hub.channelCount("room-1")).toBe(0);
    expect(hub.stats().connectionsTerminated).toBe(1);
  });

  it("resets the drop counter after the connection drains", async () => {
    const slow = makeConnection("c1", { bufferedAmount: 4096 });
    const hub = new RealtimeHub({
      heartbeat: false,
      backpressure: { maxBufferedBytes: 64, maxConsecutiveDrops: 2 },
    });

    await joined(hub, "room-1", slow);
    await hub.broadcast("room-1", "hi");

    slow.bufferedAmount = 0;
    expect(await hub.broadcast("room-1", "hi")).toBe(1);

    slow.bufferedAmount = 4096;
    await hub.broadcast("room-1", "hi");

    expect(slow.terminations).toBe(0);
    expect(hub.hasClient("c1")).toBe(true);
  });

  it("does not drop connections without buffered amount reporting", async () => {
    const opaque = makeConnection("c1", { bufferedAmount: undefined as never });
    const hub = new RealtimeHub({
      heartbeat: false,
      backpressure: { maxBufferedBytes: 1, maxConsecutiveDrops: 1 },
    });

    await joined(hub, "room-1", opaque);
    expect(await hub.broadcast("room-1", "hi")).toBe(1);
  });
});

describe("RealtimeHub heartbeat", () => {
  it("keeps a connection that answers", async () => {
    vi.useFakeTimers();

    try {
      const hub = new RealtimeHub({ heartbeat: { intervalMs: 250, timeoutMs: 100 } });
      const connection = makeConnection("c1");

      await joined(hub, "room-1", connection);
      expect(hub.isHeartbeatRunning).toBe(true);

      for (let round = 0; round < 5; round++) {
        vi.advanceTimersByTime(250);
        expect(hub.touch("c1")).toBe(true);
      }

      expect(connection.pings).toBeGreaterThan(0);
      expect(hub.channelCount("room-1")).toBe(1);
      expect(hub.touch("unknown")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes and removes a stale connection", async () => {
    vi.useFakeTimers();

    try {
      const hub = new RealtimeHub({ heartbeat: { intervalMs: 250, timeoutMs: 100 } });
      const connection = makeConnection("c1");

      await joined(hub, "room-1", connection);

      vi.advanceTimersByTime(250);
      expect(hub.channelCount("room-1")).toBe(1);

      await vi.advanceTimersByTimeAsync(500);

      expect(connection.closed?.code).toBe(1001);
      expect(hub.channelCount("room-1")).toBe(0);
      expect(hub.hasClient("c1")).toBe(false);
      expect(hub.stats().connectionsTerminated).toBe(1);
      expect(hub.stats().heartbeatsSent).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a connection whose ping throws", async () => {
    vi.useFakeTimers();

    try {
      const hub = new RealtimeHub({ heartbeat: { intervalMs: 250, timeoutMs: 100 } });
      const connection = makeConnection("c1", {
        ping() {
          throw new Error("socket dead");
        },
      });

      await joined(hub, "room-1", connection);
      await vi.advanceTimersByTimeAsync(250);

      expect(hub.hasClient("c1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the scheduler on stopHeartbeat and close", async () => {
    vi.useFakeTimers();

    try {
      const hub = new RealtimeHub({ heartbeat: { intervalMs: 250, timeoutMs: 100 } });
      const connection = makeConnection("c1");

      await joined(hub, "room-1", connection);

      hub.stopHeartbeat();
      expect(hub.isHeartbeatRunning).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(connection.pings).toBe(0);

      hub.startHeartbeat({ intervalMs: 250 });
      expect(hub.isHeartbeatRunning).toBe(true);

      hub.close();
      expect(hub.isHeartbeatRunning).toBe(false);

      const pingsAtClose = connection.pings;
      vi.advanceTimersByTime(1000);
      expect(connection.pings).toBe(pingsAtClose);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RealtimeHub lifecycle", () => {
  it("close shuts down connections, channels and state", async () => {
    const hub = new RealtimeHub();
    const first = makeConnection("c1");
    const second = makeConnection("c2");

    await joined(hub, "room-1", first);
    await joined(hub, "room-2", second);

    hub.close();

    expect(hub.isClosed).toBe(true);
    expect(hub.clientCount()).toBe(0);
    expect(hub.channelCount("room-1")).toBe(0);
    expect(first.closed?.code).toBe(1001);
    expect(second.closed?.code).toBe(1001);
    expect(hub.stats().connections).toBe(0);
  });

  it("close is idempotent", async () => {
    const hub = new RealtimeHub();
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    hub.close();

    expect(() => hub.close()).not.toThrow();
    expect(() => hub.close()).not.toThrow();
    expect(connection.closed).toEqual({ code: 1001, reason: "Server shutting down" });
  });

  it("close survives a connection that throws while closing", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1", {
      close() {
        throw new Error("already destroyed");
      },
    });

    await joined(hub, "room-1", connection);

    expect(() => hub.close()).not.toThrow();
    expect(hub.clientCount()).toBe(0);
    expect(hub.channelCount("room-1")).toBe(0);
  });

  it("rejects operations after close", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    hub.close();

    await expect(joined(hub, "room-1", connection)).rejects.toBeInstanceOf(
      ConnectionClosedError,
    );
    await expect(hub.broadcast("room-1", "hi")).rejects.toBeInstanceOf(
      ConnectionClosedError,
    );
    await expect(hub.authenticate({ connection })).rejects.toBeInstanceOf(
      ConnectionClosedError,
    );
  });

  it("reports stats without exposing counters", async () => {
    const hub = new RealtimeHub({ heartbeat: false });

    await joined(hub, "room-1", makeConnection("c1"));
    await hub.broadcast("room-1", "hi");

    expect(hub.stats()).toEqual({
      connections: 1,
      channels: 1,
      subscribers: 1,
      messagesSent: 1,
      messagesDropped: 0,
      sendFailures: 0,
      broadcasts: 1,
      connectionsAccepted: 1,
      connectionsRejected: 0,
      channelsRemoved: 0,
      authorizationsDenied: 0,
      heartbeatsSent: 0,
      connectionsTerminated: 0,
    });
  });

  it("counts a client in several channels once in stats and subscribers", async () => {
    // Membership is per channel but a client is one connection, so an operator
    // reading `connections` must not see it inflate with every extra channel.
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    await joined(hub, "room-2", connection);

    expect(hub.stats()).toMatchObject({ connections: 1, channels: 2, subscribers: 2 });

    await hub.broadcast("room-1", "hi");

    // One write, because the broadcast had a single member to reach.
    expect(hub.stats()).toMatchObject({ connections: 1, messagesSent: 1 });

    hub.close();
  });

  it("shares nothing between two hubs", async () => {
    // A module-level cache keyed on the wrong thing, or one hub reusing another's
    // connections, would show up here first.
    const first = new RealtimeHub({ heartbeat: false });
    const second = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(first, "room-1", connection);

    expect(second.clientCount()).toBe(0);
    expect(second.channelCount("room-1")).toBe(0);
    expect(second.channelsFor("c1")).toEqual([]);
    expect(await second.broadcast("room-1", "hi")).toBe(0);
    expect(frames(connection)).toEqual([]);

    // The same client id in the other hub is a different client.
    await joined(second, "room-1", makeConnection("c1"));
    expect(first.clientCount()).toBe(1);
    expect(second.clientCount()).toBe(1);

    first.close();
    second.close();
  });

  it("delivers nothing when close lands while a broadcast is authorizing", async () => {
    // The authorize hook is async, so a shutdown can land between the decision
    // and the write. The broadcast must settle rather than hang or write to a
    // connection the hub has already released.
    let release: () => void = () => {};
    let gate: Promise<void> | null = null;
    const hub = new RealtimeHub({
      heartbeat: false,
      authorize: async () => {
        // Only the broadcast is held up, never the join that precedes it.
        await gate;
        return true;
      },
    });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);

    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = hub.broadcast("room-1", "late");

    hub.close();
    release();

    expect(await pending).toBe(0);
    expect(frames(connection)).toEqual([]);
    expect(hub.stats().messagesSent).toBe(0);
  });

  it("reports an unknown client when metadata is patched", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);

    // A typo in an id is a no-op returning false, not a silent success that
    // leaves the caller believing the patch landed.
    expect(hub.attachMetadata("nope", { role: "reader" })).toBe(false);
    expect(hub.attachMetadata("c1", "not an object" as never)).toBe(false);
    expect(hub.client("c1")?.metadata).toEqual({});

    expect(hub.attachMetadata("c1", { role: "reader" })).toBe(true);
    expect(hub.client("c1")?.metadata).toEqual({ role: "reader" });

    hub.close();
  });
});

describe("RealtimeHub E2EE", () => {
  it("rejects an unusable client key at registration", async () => {
    // A key of the wrong length used to be stored, and the failure surfaced much
    // later: every message to that client was skipped silently and a direct
    // sendEncrypted() threw a raw RangeError from inside libsodium.
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });
    const connection = makeConnection("c1");
    const client = await joined(hub, "room-1", connection);

    expect(() => hub.registerClientKey(client, Buffer.alloc(16))).toThrow(RangeError);
    expect(() => hub.registerClientKey(client, Buffer.alloc(31))).toThrow(/32 bytes/);

    // A string is not a key, and Buffer.from would have base64-decoded it into
    // something plausible-looking and useless.
    expect(() => hub.registerClientKey(client, "aGVsbG8=" as never)).toThrow(TypeError);

    const keys = generateKeyPair();

    expect(hub.registerClientKey(client, keys.publicKey)).toBeInstanceOf(Buffer);
    expect(await hub.broadcastEncrypted("room-1", { type: "secret" })).toBe(1);

    hub.close();
  });

  it("treats a stored unusable key as unkeyed instead of throwing", async () => {
    // The validation above is the fix; this is the defence behind it. A key can
    // still be wrong if one was stored by an older version, so no delivery path
    // may throw on it: encryptForClient and decryptFromClient promise null.
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });
    const connection = makeConnection("c1");
    const client = await joined(hub, "room-1", connection);
    const clientKeys = (hub as unknown as { clientKeys: WeakMap<object, Buffer> })
      .clientKeys;

    clientKeys.set(connection, Buffer.alloc(8));

    expect(hub.encryptForClient(client, Buffer.from("payload"))).toBeNull();
    expect(hub.decryptFromClient(client, Buffer.alloc(64))).toBeNull();
    expect(await hub.broadcastEncrypted("room-1", { type: "secret" })).toBe(0);
    await expect(hub.sendEncrypted(client, { type: "secret" })).rejects.toBeInstanceOf(
      ConnectionError,
    );

    hub.close();
  });

  it("stays in plaintext mode until keys are installed", async () => {
    const hub = new RealtimeHub({ heartbeat: false });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);

    expect(hub.isE2EEEnabled).toBe(false);
    expect(hub.e2eePublicKey).toBeNull();
    await expect(hub.sendEncrypted(connection, "secret")).rejects.toBeInstanceOf(
      ConnectionError,
    );

    // A broadcast has no target to blame, so without this check it skipped every
    // member and returned 0: a misconfigured hub looked like an empty channel and
    // the messages were simply gone.
    await expect(hub.broadcastEncrypted("room-1", "secret")).rejects.toBeInstanceOf(
      ConnectionError,
    );
    await expect(hub.broadcastEncrypted("room-1", "secret")).rejects.toThrow(
      /E2EE is not enabled/,
    );

    hub.close();
  });

  it("createRealtimeHub enables E2EE with a hub key pair", async () => {
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });

    expect(hub.isE2EEEnabled).toBe(true);
    expect(hub.e2eePublicKey?.length).toBe(sodium.crypto_box_PUBLICKEYBYTES);
    hub.close();
  });

  it("encrypts per-client delivery for registered keys only", async () => {
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });
    const registered = makeConnection("c1");
    const bare = makeConnection("c2");

    const clientKeys = generateClientKeys();
    await joined(hub, "room-1", registered);
    await joined(hub, "room-1", bare);

    const hubKey = hub.registerClientKey(registered, clientKeys.publicKey);
    expect(hubKey).toEqual(hub.e2eePublicKey);

    expect(await hub.sendEncrypted(registered, { type: "secret" })).toBe(true);
    expect(firstFrame(registered).type).toBe("e2ee");
    expect(firstFrame(registered).ciphertext).toBeTypeOf("string");

    // A joined client without a registered key cannot be served encrypted.
    await expect(hub.sendEncrypted(bare, { type: "secret" })).rejects.toBeInstanceOf(
      ConnectionError,
    );
    expect(frames(bare)).toHaveLength(0);

    hub.removeClientKey(registered);
    expect(hub.encryptForClient(registered, new Uint8Array([1]))).toBeNull();
  });

  it("skips members without keys in an encrypted broadcast", async () => {
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });
    const registered = makeConnection("c1");
    const bare = makeConnection("c2");

    await joined(hub, "room-1", registered);
    await joined(hub, "room-1", bare);
    hub.registerClientKey(registered, generateClientKeys().publicKey);

    expect(await hub.broadcastEncrypted("room-1", { type: "secret" })).toBe(1);
    expect(frames(registered)).toHaveLength(1);
    expect(frames(bare)).toHaveLength(0);
    expect(hub.hasClient("c2")).toBe(true);
  });

  it("round-trips a payload through encryptForClient and decryptFromClient", async () => {
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });
    const connection = makeConnection("c1");
    const clientKeys = generateClientKeys();

    await joined(hub, "room-1", connection);
    hub.registerClientKey(connection, clientKeys.publicKey);

    const ciphertext = hub.encryptForClient(connection, Buffer.from("hello"));

    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(ciphertext as Uint8Array).toString("utf8")).not.toContain("hello");

    const sharedKey = computeSharedKey(hub.e2eePublicKey as Buffer, clientKeys.privateKey);
    expect(
      decryptWithSharedKey(Buffer.from(ciphertext as Uint8Array), sharedKey).toString(),
    ).toBe("hello");

    // Key helpers address a connection, not an id: the registry is a WeakMap.
    expect(hub.encryptForClient(makeConnection("unknown"), Buffer.from("hello"))).toBeNull();
  });

  it("decrypts client frames and returns null for garbage", async () => {
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });
    const connection = makeConnection("c1");
    const clientKeys = generateClientKeys();

    await joined(hub, "room-1", connection);
    const hubKey = hub.registerClientKey(connection, clientKeys.publicKey);
    expect(hubKey).not.toBeNull();

    // Client side of the shared secret: the hub's public key with the client's private key.
    const sharedKey = computeSharedKey(hub.e2eePublicKey as Buffer, clientKeys.privateKey);
    const { encryptWithSharedKey } = await import("../src/e2ee.js");

    // Both the raw ciphertext and the wrapped wire frame are accepted.
    const raw = encryptWithSharedKey(Buffer.from("ping"), sharedKey);
    expect(Buffer.from(hub.decryptFromClient(connection, raw) as Uint8Array).toString()).toBe(
      "ping",
    );

    const wrapped = { type: "e2ee" as const, ciphertext: toBase64(raw) };
    expect(
      Buffer.from(hub.decryptFromClient(connection, wrapped) as Uint8Array).toString(),
    ).toBe("ping");

    expect(hub.decryptFromClient(connection, { type: "other" } as never)).toBeNull();
    expect(hub.decryptFromClient(connection, Buffer.alloc(8))).toBeNull();
    expect(hub.decryptFromClient(makeConnection("unknown"), raw)).toBeNull();
  });

  it("broadcastEncrypted fans out to every registered client", async () => {
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });
    const first = makeConnection("c1");
    const second = makeConnection("c2");

    await joined(hub, "room-1", first);
    await joined(hub, "room-1", second);
    hub.registerClientKey(first, generateClientKeys().publicKey);
    hub.registerClientKey(second, generateClientKeys().publicKey);

    expect(await hub.broadcastEncrypted("room-1", { type: "secret" })).toBe(2);
    expect(firstFrame(first).type).toBe("e2ee");
    expect(firstFrame(first).ciphertext).not.toBe(firstFrame(second).ciphertext);
  });

  it("removes client keys when a client disconnects", async () => {
    const hub = await createRealtimeHub({ heartbeat: false, e2ee: true });
    const connection = makeConnection("c1");

    await joined(hub, "room-1", connection);
    hub.registerClientKey(connection, generateClientKeys().publicKey);
    await hub.disconnect("c1");

    expect(hub.encryptForClient(connection, Buffer.from("hello"))).toBeNull();
  });
});

function generateClientKeys(): { publicKey: Buffer; privateKey: Buffer } {
  const keyPair = sodium.crypto_box_keypair();
  return {
    publicKey: Buffer.from(keyPair.publicKey),
    privateKey: Buffer.from(keyPair.privateKey),
  };
}