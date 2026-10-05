import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { RealtimeError } from "./errors.js";
import {
  CONNECTION_OPEN,
  decodeMessage,
  type Client,
  type Connection,
  type Logger,
  type RealtimeHub,
} from "./hub.js";

/**
 * Transport adapters.
 *
 * The hub only ever sees a {@link Connection}: something with `send()`, `close()`
 * and `readyState`. This module is where a concrete server's socket becomes one,
 * which is what lets the same code serve Fastify, a bare `node:http` server, or
 * anything else that can hand over a socket.
 *
 * ```text
 *   Fastify (@fastify/websocket)  ─┐
 *   node:http / node:https  ───────┼──> createConnectionAdapter()  ──> RealtimeHub
 *   express, uWebSockets, Bun  ─────┘
 *                                    attachWebSocketAdapter() owns the ws upgrade
 * ```
 *
 * Nothing here imports Fastify. The Fastify plugin in `plugin.ts` is one consumer
 * of this adapter, not a special case in the core.
 */

/** A connection as handlers see it: neutral, plus what the hub knows about it. */
export interface RealtimeConnection {
  clientId: string;
  channel: string;
  /** The transport-neutral connection. */
  connection: Connection;
  hub: RealtimeHub;
  /** The underlying upgrade request, when the transport had one. */
  request?: IncomingMessage;
  /** Metadata returned by the `authenticate` hook. */
  metadata: Readonly<Record<string, unknown>>;
}

export type RealtimeConnectionHandler = (
  connection: RealtimeConnection,
) => void | Promise<void>;

export type RealtimeMessageHandler = (
  message: unknown,
  connection: RealtimeConnection,
) => void | Promise<void>;

export interface ConnectionAdapterOptions {
  hub: RealtimeHub;
  /** Channel joined on attach. Defaults to `"default"`. */
  channel?: string;
  onConnection?: RealtimeConnectionHandler;
  onMessage?: RealtimeMessageHandler;
  logger?: Logger;
  /**
   * Close code used when a peer is refused after its handshake already completed,
   * as with `@fastify/websocket` or a caller-owned `ws` server. Default `1008`.
   *
   * Refusals raised before the handshake answer with a plain HTTP error instead,
   * because a WebSocket close frame would require an open socket the peer must
   * never get to see.
   */
  refusedCloseCode?: number;
}

/**
 * The contract a transport implements.
 *
 * A new server needs to provide a `Connection` and call `attach()`; message
 * routing, authentication, authorization and cleanup come for free.
 */
export interface ConnectionAdapter {
  readonly hub: RealtimeHub;
  /**
   * Run the authentication hook without joining a channel.
   *
   * A transport that can refuse a peer before completing its handshake calls this
   * first and passes the result to {@link attach}. Returns the metadata to attach,
   * or `null` when the peer was refused, in which case the caller closes the
   * socket the way its protocol requires.
   */
  authenticate(socket: Connection, request?: unknown): Promise<Record<string, unknown> | null>;
  /**
   * Authenticate, join and start routing a socket.
   *
   * Pass `metadata` from a previous {@link authenticate} call to skip a second
   * round trip to the hook. Returns the client on success, or `null` when the
   * connection was refused, in which case the socket has already been closed.
   */
  attach(
    socket: Connection,
    request?: unknown,
    metadata?: Record<string, unknown>,
  ): Promise<Client | null>;
  /** Route one raw frame to the `onMessage` handler. */
  handleMessage(
    connection: RealtimeConnection,
    data: Uint8Array | Buffer | string,
    isBinary?: boolean,
  ): Promise<void>;
  /** Remove a client from the hub without closing its socket. */
  release(clientId: string): Promise<void>;
  /** Terminate every attached socket and forget them. */
  close(code?: number, reason?: string): void;
  /** Number of currently attached sockets. */
  readonly size: number;
}

const DEFAULT_CHANNEL = "default";
const POLICY_VIOLATION = 1008;
const GOING_AWAY = 1001;

/**
 * Build an adapter over any connection satisfying {@link Connection}.
 *
 * This is the whole transport integration. `ws` sockets, `@fastify/websocket`
 * sockets and browser-style sockets all take the same path.
 */
export function createConnectionAdapter(
  options: ConnectionAdapterOptions,
): ConnectionAdapter {
  const {
    hub,
    channel = DEFAULT_CHANNEL,
    onConnection,
    onMessage,
    logger,
    refusedCloseCode = POLICY_VIOLATION,
  } = options;

  const sockets = new Set<Connection>();

  async function handleMessage(
    connection: RealtimeConnection,
    data: Uint8Array | Buffer | string,
    isBinary = true,
  ): Promise<void> {
    if (!onMessage) {
      return;
    }

    try {
      // `decodeMessage` needs the binary flag: the hub's own frames are binary
      // notepack, while a client is free to send plain JSON text.
      await onMessage(decodeMessage(data, isBinary), connection);
    } catch (error) {
      logger?.error?.(
        { err: error, clientId: connection.clientId },
        "Realtime message handler failed",
      );
    }
  }

  async function authenticate(
    socket: Connection,
    request?: unknown,
  ): Promise<Record<string, unknown> | null> {
    // Authenticating before the client becomes a channel member keeps a refused
    // peer from costing a connection slot, a heartbeat or a key.
    try {
      return await hub.authenticate({ connection: socket, request });
    } catch (error) {
      logger?.warn?.({ err: error }, "Realtime authentication rejected a connection");
      return null;
    }
  }

  async function attach(
    socket: Connection,
    request?: unknown,
    authenticated?: Record<string, unknown>,
  ): Promise<Client | null> {
    if (hub.isClosed) {
      closeSocket(socket, GOING_AWAY, "Server shutting down", logger);
      return null;
    }

    let metadata = authenticated;

    if (metadata === undefined) {
      const resolved = await authenticate(socket, request);

      if (resolved === null) {
        closeSocket(socket, refusedCloseCode, "Unauthorized", logger);
        return null;
      }

      metadata = resolved;
    }

    let client: Client;

    try {
      client = await hub.join(channel, { connection: socket, metadata });
    } catch (error) {
      // An authorization denial is an expected outcome and stays quiet; every
      // other rejection means the server is misconfigured or full.
      if (!(error instanceof RealtimeError) || error.code !== "AUTHORIZATION_ERROR") {
        logger?.warn?.({ err: error, channel }, "Realtime join rejected");
      }

      closeSocket(
        socket,
        error instanceof RealtimeError && error.code === "AUTHORIZATION_ERROR"
          ? refusedCloseCode
          : 1013,
        error instanceof Error ? error.message : "Rejected",
        logger,
      );
      return null;
    }

    sockets.add(socket);

    const connection: RealtimeConnection = {
      clientId: client.id,
      channel,
      connection: socket,
      hub,
      request: request as IncomingMessage | undefined,
      metadata: client.metadata,
    };

    const emitter = socket as unknown as EventEmitterLike;

    if (typeof emitter.on === "function") {
      emitter.on("message", (data: Uint8Array | Buffer | string, isBinary: boolean) => {
        void handleMessage(connection, data, isBinary);
      });

      emitter.on("error", (error: Error) => {
        logger?.error?.({ err: error, clientId: client.id }, "Realtime socket error");
        void hub.disconnect(client.id);
      });

      emitter.on("close", () => {
        sockets.delete(socket);
        void hub.disconnect(client.id);
      });
    }

    if (onConnection) {
      void (async () => {
        try {
          await onConnection(connection);
        } catch (error) {
          logger?.error?.(
            { err: error, clientId: client.id },
            "Realtime connection handler failed",
          );

          sockets.delete(socket);
          await hub.disconnect(client.id);
        }
      })();
    }

    return client;
  }

  return {
    hub,
    get size() {
      return sockets.size;
    },
    authenticate,
    attach,
    handleMessage,

    async release(clientId: string): Promise<void> {
      await hub.disconnect(clientId);
    },

    close(code = GOING_AWAY, reason = "Server shutting down"): void {
      // Terminate rather than close gracefully. A peer that ignores the closing
      // handshake keeps Node's HTTP server from closing, which stalls
      // `server.close()` and every shutdown that waits on it.
      for (const socket of sockets) {
        try {
          if (typeof socket.terminate === "function") {
            socket.terminate();
          } else {
            socket.close(code, reason);
          }
        } catch {
          // Already gone.
        }
      }

      sockets.clear();
    },
  };
}

/**
 * Keep a refused socket's asynchronous failure from reaching the process.
 *
 * `ws` reports closing before the handshake finished by emitting `error` on a
 * later tick, and an `EventEmitter` with no `error` listener turns that into an
 * uncaught exception. Since every rejection path closes a socket that never got
 * as far as the handler wiring, a peer the server refuses could otherwise take
 * the whole process down.
 */
function absorbAsyncError(socket: Connection, logger?: Logger): void {
  const emitter = socket as unknown as Partial<EventEmitterLike> & {
    listenerCount?(event: string): number;
  };

  if (
    typeof emitter.on !== "function" ||
    typeof emitter.listenerCount !== "function" ||
    emitter.listenerCount("error") > 0
  ) {
    return;
  }

  emitter.on("error", (error: Error) => {
    logger?.debug?.({ err: error }, "Realtime socket failed after it was refused");
  });
}

function closeSocket(socket: Connection, code: number, reason: string, logger?: Logger): void {
  absorbAsyncError(socket, logger);
  try {
    socket.close(code, reason);
  } catch {
    // A socket that cannot be closed cleanly is already gone.
  }
}

/** Refuse a server that already has an adapter, then record the claim. */
function claim(resource: object, what: string): void {
  const target = resource as Record<symbol, unknown>;

  if (target[ATTACHED]) {
    throw new TypeError(
      `${what} already has a realtime adapter attached. Two adapters on one ` +
        "server both handle the same upgrade, and only the first receives " +
        "connections, so close the previous adapter before attaching another.",
    );
  }

  target[ATTACHED] = true;
}

/** The event surface an adapter uses when the transport is an emitter. */
interface EventEmitterLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/**
 * A stand-in for a socket whose handshake has not completed yet.
 *
 * Authentication hooks receive a connection, so a transport that refuses peers
 * before the handshake still has to supply one. Writing a frame is refused
 * outright: raw bytes on an unfinished upgrade would corrupt the HTTP stream.
 */
function pendingConnection(socket: Duplex): Connection {
  return {
    readyState: CONNECTION_OPEN,
    send() {
      throw new Error("Cannot write to a socket whose handshake has not completed");
    },
    close() {
      socket.destroy();
    },
    terminate() {
      socket.destroy();
    },
  };
}

/** Answer an upgrade with a plain HTTP error instead of opening a socket. */
function refuseUpgrade(socket: Duplex, status: number, statusText: string): void {
  const body = `${statusText}\n`;
  const response =
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `\r\n${body}`;

  // `end` rather than `destroy` so the client learns why it was turned away
  // before the socket goes away.
  try {
    socket.end(response);
  } catch {
    socket.destroy();
  }
}

// --------------------------------------------------------------------------
// ws: the default transport, usable with any Node HTTP server
// --------------------------------------------------------------------------

/** The minimum of `ws.WebSocketServer` this module uses. */
export interface WebSocketServerLike {
  on(event: "connection", listener: (socket: Connection, request: unknown) => void): unknown;
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: Connection) => void,
  ): void;
  close(callback?: () => void): void;
}

/**
 * The minimum of `node:http.Server` this module uses.
 *
 * Declared with concrete parameter types rather than a rest signature so that a
 * real `http.Server`, an `https.Server` and Fastify's `app.server` are all
 * assignable without a cast.
 */
export interface HttpServerLike {
  on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  removeListener(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  listenerCount(event: "upgrade"): number;
}

export interface AttachWebSocketAdapterOptions extends Omit<ConnectionAdapterOptions, "hub"> {
  /** Required unless an `adapter` is supplied. */
  hub?: RealtimeHub;
  /** Reuse an adapter instead of building one. */
  adapter?: ConnectionAdapter;
  /** Upgrade path to accept. Defaults to `"/ws"`. Others are destroyed. */
  path?: string;
  /** Largest accepted inbound frame, in bytes. Defaults to 1 MiB. */
  maxPayload?: number;
  /**
   * An existing `ws` server to drive, such as `app.websocketServer` from
   * `@fastify/websocket`. It is never closed by this module.
   */
  server?: WebSocketServerLike;
  /** Set to `false` to build the adapter without wiring the upgrade. */
  attach?: boolean;
}

export interface AttachedWebSocketAdapter {
  adapter: ConnectionAdapter;
  /**
   * Detach the upgrade listener, terminate live sockets, and close a `ws` server
   * this module created. Idempotent.
   */
  close(): Promise<void>;
}

const DEFAULT_PATH = "/ws";
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

/**
 * Marks a server that already has an adapter bound to it.
 *
 * A global symbol keeps the marker shared across duplicated copies of the package
 * in one dependency tree, and the marker lives on the server object itself rather
 * than in a module-level set, so it dies with the server and never leaks state
 * between hubs.
 */
const ATTACHED = Symbol.for("@oneunit/realtime:attached");

/**
 * Attach a connection adapter to any Node HTTP server, over `ws`.
 *
 * Works with `node:http`, `node:https`, Express, and Fastify (pass
 * `app.server`). Nothing here knows about a framework.
 */
export async function attachWebSocketAdapter(
  server: HttpServerLike,
  options: AttachWebSocketAdapterOptions,
): Promise<AttachedWebSocketAdapter> {
  const {
    path = DEFAULT_PATH,
    maxPayload = DEFAULT_MAX_PAYLOAD,
    attach = true,
    server: existing,
    logger,
  } = options;

  if (!options.adapter && !options.hub) {
    throw new TypeError("attachWebSocketAdapter() needs either a hub or an adapter");
  }

  const adapter = options.adapter ?? createConnectionAdapter(options as ConnectionAdapterOptions);
  const owned = existing === undefined;
  const wss =
    existing ?? new (await import("ws")).WebSocketServer({ noServer: true, maxPayload });

  // Two adapters on one server is silent connection loss: both upgrade handlers
  // run, the first consumes the socket, and the second never sees a connection
  // with no error reported anywhere. Refused instead, per resource, so a
  // caller-supplied `ws` server and an owned one are each claimed once.
  const claims: object[] = [];

  let upgradeHandler:
    | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null;
  let listening = false;

  if (existing) {
    // The owner already emits `connection`; listen instead of upgrading.
    const onConnection = (socket: Connection, request: unknown): void => {
      void adapter.attach(socket, request);
    };

    wss.on("connection", onConnection);
  }

  if (attach && owned) {
    upgradeHandler = (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ): void => {
      if (!matchesPath(request.url, path)) {
        // An upgrade we do not own must not linger. Destroying it is what keeps an
        // unmatched request from leaking a socket.
        if (server.listenerCount("upgrade") === 1) {
          socket.destroy();
        }
        return;
      }

      if (adapter.hub.isClosed) {
        refuseUpgrade(socket, 503, "Service Unavailable");
        return;
      }

      // The handshake is deliberately held back until the hook has answered. A
      // peer the server refuses must never see an open socket, so the rejection
      // is a plain HTTP error rather than a WebSocket close frame.
      let upgraded = false;

      void (async () => {
        const metadata = await adapter.authenticate(pendingConnection(socket), request);

        if (metadata === null) {
          refuseUpgrade(socket, 401, "Unauthorized");
          return;
        }

        wss.handleUpgrade(request, socket, head, (accepted) => {
          upgraded = true;
          void adapter.attach(accepted, request, metadata);
        });
      })().catch((error) => {
        logger?.warn?.({ err: error }, "Realtime upgrade failed");

        if (upgraded) {
          socket.destroy();
          return;
        }

        refuseUpgrade(socket, 500, "Internal Server Error");
      });
    };

    claim(server, "The HTTP server");
    claims.push(server);
    server.on("upgrade", upgradeHandler);
    listening = true;
  }

  let closed = false;

  return {
    adapter,

    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      adapter.close(GOING_AWAY, "Server shutting down");

      if (listening && upgradeHandler) {
        server.removeListener("upgrade", upgradeHandler);
        listening = false;
      }

      // The claims go with the adapter, so a fresh one may be attached later.
      for (const resource of claims) {
        delete (resource as Record<symbol, unknown>)[ATTACHED];
      }

      // A server we did not create belongs to the caller; only close our own.
      if (!owned) {
        return;
      }

      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

/**
 * Whether an upgrade request targets the realtime path.
 *
 * Matches the path itself and its children, so `/ws` also serves `/ws/chat`.
 */
export function matchesPath(url: string | undefined, path: string): boolean {
  if (!url) {
    return false;
  }

  const pathname = url.split("?")[0];
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;

  if (normalized === "") {
    return pathname === "/";
  }

  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}