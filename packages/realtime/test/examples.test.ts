import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect as tcpConnect, createServer } from "node:net";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { decode } from "notepack.io";
import { decryptWithSharedKey, fromBase64 } from "../src/e2ee.js";

// Resolving a path against a file URL treats the file itself as the last
// segment, so reaching the package root takes two levels up, not one.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const tsxCli = fileURLToPath(new URL("node_modules/tsx/dist/cli.mjs", new URL("../", import.meta.url)));

interface RunningExample {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  output: string;
}

const running: RunningExample[] = [];

const BOOT_TIMEOUT_MS = 20_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();

      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not reserve a port"));
        return;
      }

      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function startExample(script: string, port: number, env: NodeJS.ProcessEnv = {}): RunningExample {
  const child = spawn(process.execPath, [tsxCli, `examples/${script}`], {
    cwd: packageRoot,
    env: { ...process.env, PORT: String(port), LOG_LEVEL: "silent", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // tsx re-executes node, so the process that has to die is a grandchild.
    // A new process group makes the whole tree reachable with one negative pid.
    detached: true,
  });

  const instance: RunningExample = { child, port, output: "" };
  const collect = (chunk: Buffer) => {
    instance.output += chunk.toString();
  };

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  // A failed spawn emits `error` and never exits, so without this the wait
  // below would spin until the timeout with no clue why.
  child.on("error", (error) => {
    instance.output += `spawn error: ${error.message}`;
  });
  running.push(instance);

  return instance;
}

interface FinishedExample {
  code: number | null;
  output: string;
}

/**
 * Run an example that exits by itself, which is what the client examples do once
 * they have seen a round trip.
 *
 * The clients are covered here on purpose: they are the only examples no test
 * drove before, and a client that cannot decode what the hub sends still starts
 * cleanly, so "it ran" is not evidence it works.
 */
function runExample(
  script: string,
  env: NodeJS.ProcessEnv,
  timeout = 20_000,
): Promise<FinishedExample> {
  const instance = startExample(script, 0, env);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      instance.child.kill("SIGKILL");
      resolve({ code: -1, output: `${instance.output}\ntimed out after ${timeout}ms` });
    }, timeout);

    timer.unref?.();

    instance.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output: instance.output });
    });
  });
}

async function waitForPort(port: number, instance: RunningExample): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      throw new Error(`example exited early (${instance.child.exitCode}):\n${instance.output}`);
    }

    // A TCP connect is the only readiness signal every example shares: each
    // one serves its own WebSocket path, so probing one path would only prove
    // that path is missing.
    const reachable = await new Promise<boolean>((resolve) => {
      const probe = tcpConnect({ host: "127.0.0.1", port });

      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });

    if (reachable) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`example did not start listening on ${port}:\n${instance.output}`);
}

interface TestClient {
  frames: Record<string, unknown>[];
  next(timeout?: number): Promise<Record<string, unknown>>;
  /** Next frame of a given `type`, whatever else arrives in between. */
  nextOfType(type: string, timeout?: number): Promise<Record<string, unknown>>;
  send(data: unknown): void;
  close(): void;
}

function connect(url: string): Promise<TestClient> {
  const socket = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  const filters: Array<(frame: Record<string, unknown>) => boolean> = [];

  const flush = (): void => {
    // A typed waiter only accepts its own frame type, so unrelated frames stay
    // buffered instead of failing the read. Fan-out and notifications arrive in
    // whatever order the server produced them.
    while (waiters.length > 0) {
      const index = filters[0] ? frames.findIndex(filters[0]) : 0;

      if (index < 0) {
        return;
      }

      const [frame] = frames.splice(index, 1);
      filters.shift();
      waiters.shift()?.(frame);
    }
  };

  socket.on("message", (data) => {
    const frame = decode(data) as Record<string, unknown>;

    if (waiters.length > 0) {
      frames.push(frame);
      flush();
      return;
    }

    frames.push(frame);
  });

  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => {
      resolve({
        frames,
        next(timeout = 5000) {
          const buffered = frames.shift();
          if (buffered) {
            return Promise.resolve(buffered);
          }

          return new Promise((resolveFrame, rejectFrame) => {
            const timer = setTimeout(
              () => rejectFrame(new Error("no frame received before timeout")),
              timeout,
            );

            waiters.push((frame) => {
              clearTimeout(timer);
              resolveFrame(frame);
            });
            filters.push(() => true);
          });
        },

        nextOfType(type, timeout = 5000) {
          return new Promise((resolveFrame, rejectFrame) => {
            const timer = setTimeout(
              () => rejectFrame(new Error(`no "${type}" frame received before timeout`)),
              timeout,
            );

            waiters.push((frame) => {
              clearTimeout(timer);
              resolveFrame(frame);
            });
            filters.push((frame) => frame.type === type);
            flush();
          });
        },
        send(data: unknown) {
          socket.send(JSON.stringify(data));
        },
        close() {
          socket.terminate();
        },
      });
    });
  });
}

const clients: TestClient[] = [];

async function connectTracked(url: string): Promise<TestClient> {
  const client = await connect(url);
  clients.push(client);
  return client;
}

afterAll(async () => {
  for (const client of clients) {
    client.close();
  }

  for (const { child } of running) {
    if (child.pid === undefined || child.exitCode !== null) {
      continue;
    }

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
});

describe("examples run as documented", () => {
  it("chat.ts and client.ts exchange a room message", async () => {
    const port = await freePort();
    const example = startExample("chat.ts", port);

    await waitForPort(port, example);

    const room = `room-${randomUUID().slice(0, 8)}`;
    const alice = await connectTracked(`ws://127.0.0.1:${port}/ws/chat?room=${room}&name=alice`);
    const welcome = await alice.next();

    expect(welcome).toMatchObject({ type: "welcome", room, name: "alice", members: 1 });

    const bob = await connectTracked(`ws://127.0.0.1:${port}/ws/chat?room=${room}&name=bob`);
    expect(await bob.next()).toMatchObject({ type: "welcome", members: 2 });

    // Alice learns about the join, then both see each other's messages.
    expect(await alice.next()).toMatchObject({ type: "presence", event: "joined", name: "bob" });

    alice.send({ type: "message", text: "hello bob" });

    // Bob receives it once; Alice receives her own echo, which is what the
    // example broadcasts to the whole room so a single client sees a round trip.
    expect(await bob.next()).toMatchObject({
      type: "message",
      from: welcome.clientId,
      name: "alice",
      text: "hello bob",
    });
    expect(await alice.next()).toMatchObject({
      type: "message",
      text: "hello bob",
    });

    alice.send({ type: "not-a-message-type" });
    expect(await alice.next()).toMatchObject({ type: "error" });

    // Oversized input is refused by the server, not buffered: maxPayload is
    // 64 KiB here and the frame is 128 KiB.
    const refused = new Promise<number>((resolve) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws/chat?room=${room}&name=big`,
      );

      socket.on("close", (code) => resolve(code));
      socket.on("error", () => resolve(-1));
      socket.on("open", () => socket.send("x".repeat(128 * 1024)));
    });

    expect(await refused).toBe(1009);

    // The example owns its routes, so it calls hub.authenticate() itself. The
    // handshake is already complete by then (@fastify/websocket did it), so the
    // refusal arrives as a 1008 close rather than an HTTP status — and the peer
    // never becomes a channel member.
    const anonymous = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?room=${room}`);

      socket.on("close", (code) => resolve(code));
      socket.on("error", () => resolve(-1));
      setTimeout(() => resolve(-2), 5000);
    });

    expect(anonymous).toBe(1008);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const stats = (await health.json()) as { ok: boolean; stats: { connections: number } };

    expect(stats.ok).toBe(true);
    expect(stats.stats.connections).toBe(2);
  }, 30_000);

  it("plugin-ws.ts joins the configured channel and refuses oversize frames", async () => {
    const port = await freePort();
    const example = startExample("plugin-ws.ts", port, { WS_PATH: "/ws" });

    await waitForPort(port, example);

    // In this mode every connection joins the configured channel by itself, so
    // a message from one client reaches the other without any route code.
    const alice = await connectTracked(`ws://127.0.0.1:${port}/ws`);
    const bob = await connectTracked(`ws://127.0.0.1:${port}/ws`);

    alice.send({ type: "reading", sensor: "temp", celsius: 21.5 });

    expect(await bob.next()).toMatchObject({
      type: "telemetry",
      payload: { type: "reading", sensor: "temp", celsius: 21.5 },
    });

    // maxPayload is 8 KiB in this example, so a 32 KiB frame must be refused
    // rather than buffered.
    const closed = new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 5000);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      socket.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      socket.on("error", () => resolve(-1));
      socket.on("open", () => socket.send("x".repeat(32 * 1024)));
    });

    expect(await closed).toBe(1009);
  }, 30_000);

  it("standalone.ts authenticates during the upgrade", async () => {
    const port = await freePort();
    const token = "example-token";
    const example = startExample("standalone.ts", port, { WS_TOKEN: token, HEARTBEAT_MS: "1000" });

    await waitForPort(port, example);

    const rejected = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`);

      socket.on("open", () => resolve(false));
      socket.on("error", () => resolve(true));
      socket.on("close", () => resolve(true));
    });

    expect(rejected).toBe(true);

    const client = await connectTracked(`ws://127.0.0.1:${port}/ws?token=${token}`);
    expect(await client.next()).toMatchObject({ type: "welcome" });
  }, 30_000);

  it("e2ee.ts and e2ee-client.ts round-trip through per-client encryption", async () => {
    const port = await freePort();
    const example = startExample("e2ee.ts", port);

    await waitForPort(port, example);

    const alice = await connectTracked(`ws://127.0.0.1:${port}/ws/secure`);
    const bob = await connectTracked(`ws://127.0.0.1:${port}/ws/secure`);

    // Both clients derive a shared key from the hub's public key, which only
    // the hub can decrypt, and register it.
    const aliceHello = (await alice.next()) as { clientId: string; serverPublicKey: string };
    const bobHello = (await bob.next()) as { clientId: string; serverPublicKey: string };

    expect(aliceHello.serverPublicKey).toBe(bobHello.serverPublicKey);

    const hubPublicKey = fromBase64(aliceHello.serverPublicKey);

    const { generateKeyPair, computeSharedKey, toBase64 } = await import("../src/e2ee.js");
    const aliceKeys = generateKeyPair();
    const bobKeys = generateKeyPair();

    alice.send({ type: "register", publicKey: toBase64(aliceKeys.publicKey) });
    bob.send({ type: "register", publicKey: toBase64(bobKeys.publicKey) });

    // "encryptedPeers" counts members the hub can actually encrypt to, so the
    // first client to register legitimately reports none: the second has not
    // sent a key yet. Reporting members in the room instead would be a lie a
    // client could act on.
    // `ready` lists the peers that already hold a key, so a client knows whether
    // it can send yet.
    expect(await alice.nextOfType("registered")).toMatchObject({
      type: "registered",
      encryptedPeers: 0,
      members: 2,
      ready: [],
    });
    expect(await bob.nextOfType("registered")).toMatchObject({
      type: "registered",
      encryptedPeers: 1,
      members: 2,
      ready: [aliceHello.clientId],
    });

    // A client waits for a ready signal before sending, because there is nobody
    // to encrypt to until the other side has a key. Alice registered first, so
    // the signal is Bob announcing himself.
    const announced = (await alice.nextOfType("peer")) as { clientId?: unknown };
    expect(announced.clientId).toBe(bobHello.clientId);

    alice.send({ type: "message", text: "ciphertext only" });

    // The sender is excluded from its own broadcast, so the ack counts the
    // peers the message was actually encrypted for.
    const delivered = (await alice.nextOfType("sent")) as { type: string; delivered: number };
    expect(delivered).toMatchObject({ type: "sent", delivered: 1 });

    // broadcastEncrypted wraps the payload as { type: "e2ee", ciphertext }.
    const received = (await bob.nextOfType("e2ee")) as { type: string; ciphertext: string };
    expect(received.type).toBe("e2ee");

    const bobSharedKey = computeSharedKey(hubPublicKey, bobKeys.privateKey);
    // What the hub encrypted is its own encoded payload, so a client decodes it
    // after decrypting rather than parsing it as text.
    const plaintext = decryptWithSharedKey(fromBase64(received.ciphertext), bobSharedKey);

    expect(decode(plaintext)).toMatchObject({
      type: "message",
      text: "ciphertext only",
    });

    // Alice's own shared key must not open Bob's ciphertext.
    const aliceSharedKey = computeSharedKey(hubPublicKey, aliceKeys.privateKey);
    expect(() => decryptWithSharedKey(fromBase64(received.ciphertext), aliceSharedKey)).toThrow();
  }, 30_000);

  it("client.ts completes a round trip against chat.ts", async () => {
    const port = await freePort();
    const example = startExample("chat.ts", port);

    await waitForPort(port, example);

    // The documented client, run as a process: it must decode the notepack
    // frames the hub sends and close cleanly once its own message comes back.
    const client = await runExample("client.ts", {
      WS_URL: `ws://127.0.0.1:${port}/ws/chat?room=example&name=node`,
      WS_TEXT: "hello from the client example",
    });

    expect(client.code, client.output).toBe(0);
    expect(client.output).toMatch(/welcome node in example/);
    expect(client.output).toMatch(/node: hello from the client example/);
    expect(client.output).toMatch(/closed 1000/);
  }, 40_000);

  it("two e2ee-client.ts processes exchange an encrypted frame", async () => {
    const port = await freePort();
    const example = startExample("e2ee.ts", port);
    const url = `ws://127.0.0.1:${port}/ws/secure`;

    await waitForPort(port, example);

    // Both halves are real clients, so this only passes if a client can decode
    // what the hub sends (notepack, including the `{ type: "e2ee" }` wrapper),
    // register a key, and open the peer's ciphertext.
    const [alice, bob] = await Promise.all([
      runExample("e2ee-client.ts", { WS_URL: url }),
      runExample("e2ee-client.ts", { WS_URL: url }),
    ]);

    for (const client of [alice, bob]) {
      expect(client.code, client.output).toBe(0);
      expect(client.output).toMatch(/hub public key received/);
      // Two processes racing to connect: whichever registers first may not see the
      // other one in the room yet. The peer-count handshake, not the count, is
      // what has to work.
      expect(client.output).toMatch(/registered: \d+ of \d+ member\(s\) can be encrypted to/);
      expect(client.output).toMatch(/sending an encrypted message/);
      expect(client.output).toMatch(/hub encrypted the frame for 1 recipient\(s\)/);
      expect(client.output).toMatch(/decrypted: ciphertext only/);
    }
  }, 60_000);

  it("adapter.ts fans an external ingest out to local clients", async () => {
    const port = await freePort();
    const example = startExample("adapter.ts", port);

    await waitForPort(port, example);

    const client = await connectTracked(`ws://127.0.0.1:${port}/ws/subscribe?channel=orders`);
    expect(await client.next()).toMatchObject({ type: "subscribed", channel: "orders" });

    const ingest = await fetch(`http://127.0.0.1:${port}/ingest/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "order.created", id: 42 }),
    });

    expect(await ingest.json()).toMatchObject({ channel: "orders", delivered: 1 });
    expect(await client.next()).toMatchObject({ type: "order.created", id: 42 });
  }, 30_000);
});
