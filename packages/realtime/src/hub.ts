import { randomUUID } from "node:crypto";
import { encode, decode } from "notepack.io";
import {
  assertClientPublicKey,
  computeSharedKey,
  decryptWithSharedKey,
  encryptWithSharedKey,
  fromBase64,
  generateKeyPair,
  toBase64,
  e2eeReady,
  type KeyPair,
} from "./e2ee.js";
import {
  AuthorizationError,
  AuthenticationError,
  ChannelError,
  ConnectionClosedError,
  ConnectionError,
  ConnectionLimitError,
  MessageTooLargeError,
  RealtimeError,
} from "./errors.js";

/**
 * Minimal connection contract.
 *
 * The hub never imports `ws`, `@fastify/websocket` or Fastify. Anything that can
 * `send()` a frame, expose `readyState` and be closed qualifies: `ws`
 * WebSockets, `@fastify/websocket` sockets, and browser `WebSocket` all fit.
 * Everything else on this interface is optional and only used when present.
 */
export interface Connection {
  /** Numeric ready state. Only {@link CONNECTION_OPEN} is accepted. */
  readonly readyState: number;
  /** Enqueue a frame. Throwing signals a failed send. */
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Drop the connection without a closing handshake. Optional. */
  terminate?(): void;
  /** Bytes queued but not yet flushed, when the transport can report it. */
  readonly bufferedAmount?: number;
  /** Send a protocol-level ping, when the transport supports it. Optional. */
  ping?(): void;
}

/** The only `readyState` value the hub writes to. */
export const CONNECTION_OPEN = 1;

/** Immutable view of a client. */
export interface Client {
  readonly id: string;
  readonly connection: Connection;
  /** Whatever the authentication hook attached. Never interpreted by the hub. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly joinedAt: number;
  readonly lastSeenAt: number;
  /** Snapshot of channel names; mutating it cannot affect the hub. */
  readonly channels: ReadonlySet<string>;
}

export interface ClientInput {
  id?: string;
  connection: Connection;
  metadata?: Record<string, unknown>;
}

export interface JoinOptions {
  id?: string;
  metadata?: Record<string, unknown>;
}

/** Anything carrying a client id, for example a {@link Client}. */
export interface ClientRef {
  id: string;
}

/**
 * Anything that can deliver an already decoded message to a channel.
 *
 * An external adapter (Kafka, Redis, NATS, ...) implements this and calls
 * {@link BroadcastOptions}. The hub does not care which broker sits behind it,
 * and ships none.
 */
export interface BroadcastTarget {
  broadcast(
    channelName: string,
    message: unknown,
    options?: BroadcastOptions,
  ): Promise<number> | number;
}

/** Optional structured logging. Nothing is logged unless a logger is supplied. */
export interface Logger {
  debug?(payload: unknown, message?: string): void;
  info?(payload: unknown, message?: string): void;
  warn?(payload: unknown, message?: string): void;
  error?(payload: unknown, message?: string): void;
}

export interface RealtimeLimits {
  /** Clients tracked by the hub. Unlimited by default: admission is the transport's job. */
  maxConnections: number;
  /** Members allowed in a single channel. */
  maxClientsPerChannel: number;
  /** Channels one client may subscribe to. */
  maxChannelsPerClient: number;
  /** Largest encoded frame the hub hands to a connection, in bytes. */
  maxMessageSize: number;
  /** Longest accepted channel name, in characters. */
  maxChannelNameLength: number;
}

export interface HeartbeatOptions {
  /** How often the shared scheduler sweeps all connections. */
  intervalMs: number;
  /** How long a connection may go without answering a ping before it is closed. */
  timeoutMs: number;
}

export interface BackpressureOptions {
  /**
   * Bytes a connection may have queued before the hub stops writing to it.
   *
   * Limitation: this relies on `connection.bufferedAmount`, which `ws` exposes
   * but the WHATWG `WebSocket` API does not. Transports without it can never
   * trip this threshold and rely on the consecutive-drop limit and failed-send
   * handling instead.
   */
  maxBufferedBytes: number;
  /** Consecutive skipped writes before the slow connection is terminated. */
  maxConsecutiveDrops: number;
}

export type RealtimeAction = "connect" | "join" | "leave" | "send" | "broadcast";

export interface AuthenticateContext {
  connection: Connection;
  request?: unknown;
}

/**
 * Authenticate a connection. Return generic metadata to attach to the client, or
 * throw/reject to refuse it. The hub knows nothing about JWTs, cookies, sessions
 * or API keys: that decision belongs to this hook.
 */
export type AuthenticateHook = (
  context: AuthenticateContext,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export interface AuthorizeContext {
  action: RealtimeAction;
  channel?: string;
  client?: Client;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Return `false` (or throw) to deny. Roles and permissions stay in the app. */
export type AuthorizeHook = (
  context: AuthorizeContext,
) => boolean | void | Promise<boolean | void>;

export interface BroadcastOptions {
  /** Client ids to skip. */
  exclude?: Iterable<string>;
  /** Send only to these client ids. */
  include?: Iterable<string>;
  /** Recorded on the `broadcast` event. Never forwarded to clients. */
  metadata?: Record<string, unknown>;
  /**
   * Also authorize every recipient for `send`. Defaults to `false`: a relay
   * authorizes its publisher once instead of per recipient.
   */
  authorizeRecipients?: boolean;
}

export type RealtimeEventName =
  | "connect"
  | "disconnect"
  | "join"
  | "leave"
  | "send"
  | "drop"
  | "broadcast"
  | "reject";

export interface RealtimeEvent {
  name: RealtimeEventName;
  clientId?: string;
  channel?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  at: number;
}

export interface RealtimeHubStats {
  connections: number;
  channels: number;
  subscribers: number;
  messagesSent: number;
  messagesDropped: number;
  sendFailures: number;
  broadcasts: number;
  connectionsAccepted: number;
  connectionsRejected: number;
  channelsRemoved: number;
  authorizationsDenied: number;
  heartbeatsSent: number;
  connectionsTerminated: number;
}

export interface RealtimeHubOptions {
  limits?: Partial<RealtimeLimits>;
  backpressure?: Partial<BackpressureOptions>;
  /** `false` keeps the heartbeat scheduler off until `startHeartbeat()`. */
  heartbeat?: false | Partial<HeartbeatOptions>;
  authenticate?: AuthenticateHook;
  authorize?: AuthorizeHook;
  logger?: Logger;
  onEvent?: (event: RealtimeEvent) => void;
}

export const DEFAULT_LIMITS: Readonly<RealtimeLimits> = Object.freeze({
  maxConnections: Number.POSITIVE_INFINITY,
  maxClientsPerChannel: Number.POSITIVE_INFINITY,
  maxChannelsPerClient: Number.POSITIVE_INFINITY,
  maxMessageSize: 64 * 1024,
  maxChannelNameLength: 128,
});

export const DEFAULT_HEARTBEAT: Readonly<HeartbeatOptions> = Object.freeze({
  intervalMs: 30_000,
  timeoutMs: 30_000,
});

export const DEFAULT_BACKPRESSURE: Readonly<BackpressureOptions> = Object.freeze({
  maxBufferedBytes: 1024 * 1024,
  maxConsecutiveDrops: 32,
});

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

interface ClientEntry {
  readonly id: string;
  readonly connection: Connection;
  readonly channels: Set<string>;
  metadata: Record<string, unknown>;
  readonly joinedAt: number;
  lastSeenAt: number;
  pingedAt: number;
  consecutiveDrops: number;
}

interface ResolvedTarget {
  connection: Connection;
  id?: string;
  metadata?: Record<string, unknown>;
}

/** Builds the frame for one broadcast recipient. Returning `null` skips it. */
type FrameFactory = (member: ClientEntry) => Uint8Array | null;

/** Wire format of an end-to-end encrypted frame. */
export interface E2EEFrame {
  type: "e2ee";
  ciphertext: string;
}

function encryptFrame(payload: Uint8Array, sharedKey: Buffer): E2EEFrame {
  return {
    type: "e2ee",
    ciphertext: toBase64(encryptWithSharedKey(Buffer.from(payload), sharedKey)),
  };
}

/** Accept either a wrapped frame or the raw ciphertext bytes. */
function ciphertextOf(frame: Uint8Array | E2EEFrame): Buffer | null {
  if (typeof frame !== "object" || frame instanceof Uint8Array) {
    const bytes = frame as Uint8Array;

    return bytes.byteLength > 0 ? Buffer.from(bytes) : null;
  }

  if (frame.type !== "e2ee" || typeof frame.ciphertext !== "string") {
    return null;
  }

  try {
    return fromBase64(frame.ciphertext);
  } catch {
    return null;
  }
}

function isConnection(value: unknown): value is Connection {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Connection).send === "function" &&
    typeof (value as Connection).close === "function"
  );
}

function normalizeTarget(
  input: ClientInput | Connection,
  options: JoinOptions,
): ResolvedTarget {
  if (isConnection(input)) {
    return { connection: input, id: options.id, metadata: options.metadata };
  }

  const candidate = input as ClientInput;

  if (!isConnection(candidate.connection)) {
    throw new ConnectionError(
      "A connection with send() and close() is required",
      { connectionId: candidate.id },
    );
  }

  return {
    connection: candidate.connection,
    id: candidate.id ?? options.id,
    metadata: candidate.metadata ?? options.metadata,
  };
}

function positiveNumbers(values: object, label: string): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
      throw new TypeError(`${label}.${key} must be a positive number`);
    }
  }
}

/**
 * Decode a frame received from a client.
 *
 * notepack's decoder reads through the `Buffer` API, so a bare `Uint8Array` is
 * wrapped without copying first.
 *
 * `isBinary` matters and defaults to `true`, because the hub encodes everything
 * it sends as binary notepack. A transport knows which kind it received: pass the
 * `isBinary` flag of the socket's `message` event. Without it, a JSON text frame
 * is handed to the notepack decoder and throws "trailing bytes", which is a
 * confusing way to learn that a client's plain-text message was not read.
 */
export function decodeMessage(
  data: Uint8Array | Buffer | string,
  isBinary = true,
): unknown {
  if (typeof data === "string") {
    // Only a text frame arrives as a string, so it is JSON or raw text.
    return safeParseJson(data);
  }

  if (!isBinary) {
    return safeParseJson(toBuffer(data).toString("utf8"));
  }

  return decode(toBuffer(data));
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function safeParseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function encodePayload(payload: unknown): Uint8Array {
  if (typeof payload === "string") {
    return new TextEncoder().encode(payload);
  }

  return encode(payload);
}

/**
 * Local realtime connection management.
 *
 * Owns channels, membership, delivery, heartbeat and lifecycle for connections
 * held in *this* process. Cross-instance propagation is somebody else's job:
 * hand `hub.broadcast` to an external adapter that talks to whatever broker you
 * run. This package has no broker of its own.
 */
export class RealtimeHub {
  readonly limits: RealtimeLimits;

  private readonly channels = new Map<string, Set<ClientEntry>>();
  private readonly clients = new Map<string, ClientEntry>();
  private readonly clientIds = new WeakMap<Connection, string>();
  private readonly clientKeys = new WeakMap<Connection, Buffer>();
  private readonly backpressure: BackpressureOptions;
  private readonly heartbeatOptions: HeartbeatOptions;
  private readonly authenticateHook: AuthenticateHook | undefined;
  private readonly authorizeHook: AuthorizeHook | undefined;
  private readonly logger: Logger | undefined;
  private readonly eventHook: ((event: RealtimeEvent) => void) | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private signingKeyPair: KeyPair | null = null;
  private readonly counters = {
    messagesSent: 0,
    messagesDropped: 0,
    sendFailures: 0,
    broadcasts: 0,
    connectionsAccepted: 0,
    connectionsRejected: 0,
    channelsRemoved: 0,
    authorizationsDenied: 0,
    heartbeatsSent: 0,
    connectionsTerminated: 0,
  };

  constructor(options: RealtimeHubOptions = {}) {
    this.limits = Object.freeze({
      ...DEFAULT_LIMITS,
      ...options.limits,
    });
    this.backpressure = Object.freeze({
      ...DEFAULT_BACKPRESSURE,
      ...options.backpressure,
    });
    this.heartbeatOptions = Object.freeze({
      ...DEFAULT_HEARTBEAT,
      ...options.heartbeat,
    });

    positiveNumbers(this.limits, "limits");
    positiveNumbers(this.backpressure, "backpressure");
    positiveNumbers(this.heartbeatOptions, "heartbeat");

    this.authenticateHook = options.authenticate;
    this.authorizeHook = options.authorize;
    this.logger = options.logger;
    this.eventHook = options.onEvent;

    if (options.heartbeat !== false) {
      this.startHeartbeat();
    }
  }

  // ---------------------------------------------------------------- lifecycle

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Close every connection, stop timers and drop all state.
   *
   * Idempotent: calling it again is a no-op and never throws.
   */
  close(code = 1001, reason = "Server shutting down"): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopHeartbeat();

    for (const entry of [...this.clients.values()]) {
      try {
        entry.connection.close(code, reason);
      } catch (error) {
        this.warn({ err: error, clientId: entry.id }, "Failed to close connection");
      }

      this.release(entry);
      this.emit({ name: "disconnect", clientId: entry.id, reason: "closed" });
    }

    this.channels.clear();
    this.clients.clear();
    this.debug({ at: Date.now() }, "RealtimeHub closed");
  }

  // --------------------------------------------------------------------- auth

  /**
   * Run the authentication hook for a connection. A transport layer calls this
   * once, before the first {@link join}, and passes the result to `join` as
   * metadata.
   *
   * @throws AuthenticationError when the hook rejects the connection.
   */
  async authenticate(context: AuthenticateContext): Promise<Record<string, unknown>> {
    this.assertOpen();

    if (!this.authenticateHook) {
      return {};
    }

    try {
      const metadata = await this.authenticateHook(context);
      return metadata ?? {};
    } catch (error) {
      this.counters.connectionsRejected += 1;
      this.emit({ name: "reject", reason: "authenticate" });
      this.warn({ err: error }, "Realtime authentication failed");

      if (error instanceof RealtimeError) {
        throw error;
      }

      throw new AuthenticationError(undefined, { cause: error });
    }
  }

  /**
   * Merge metadata into a tracked client, for example after a token refresh.
   *
   * Returns `false` when the client is unknown or the patch is not a plain
   * object: spreading a string would quietly store it as indexed characters
   * rather than report that the caller passed the wrong thing.
   */
  attachMetadata(clientId: string, metadata: Record<string, unknown>): boolean {
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      return false;
    }

    const entry = this.clients.get(clientId);

    if (!entry) {
      return false;
    }

    entry.metadata = { ...entry.metadata, ...metadata };
    return true;
  }

  // ---------------------------------------------------------------- membership

  /**
   * Subscribe a connection to a channel.
   *
   * Duplicate joins are safe: the existing membership is returned unchanged.
   *
   * @throws AuthorizationError when the authorize hook denies `join`.
   * @throws ChannelError when the name is empty, too long or has control characters.
   * @throws ConnectionLimitError when a capacity limit is reached.
   * @throws ConnectionError when the connection is not open.
   */
  async join(
    channel: string,
    input: ClientInput | Connection,
    options: JoinOptions = {},
  ): Promise<Client> {
    this.assertOpen();

    const name = this.validateChannelName(channel);
    const target = normalizeTarget(input, options);
    const { connection } = target;

    if (connection.readyState !== CONNECTION_OPEN) {
      throw new ConnectionError("Cannot join with a connection that is not open", {
        connectionId: target.id,
      });
    }

    const existing = this.existingClient(connection, target.id);

    if (existing?.channels.has(name)) {
      return this.snapshot(existing);
    }

    const isNew = existing === undefined;

    if (isNew && this.clients.size >= this.limits.maxConnections) {
      this.reject(`Connection limit of ${this.limits.maxConnections} reached`);
      throw new ConnectionLimitError(
        `Connection limit of ${this.limits.maxConnections} reached`,
        this.limits.maxConnections,
      );
    }

    const members = this.channels.get(name);

    if ((members?.size ?? 0) >= this.limits.maxClientsPerChannel) {
      throw new ConnectionLimitError(
        `Channel "${name}" is limited to ${this.limits.maxClientsPerChannel} clients`,
        this.limits.maxClientsPerChannel,
      );
    }

    if ((existing?.channels.size ?? 0) >= this.limits.maxChannelsPerClient) {
      throw new ConnectionLimitError(
        `Client is limited to ${this.limits.maxChannelsPerClient} channels`,
        this.limits.maxChannelsPerClient,
      );
    }

    if (isNew) {
      await this.authorize({ action: "connect", metadata: target.metadata });
    }

    const entry = existing ?? this.addClient(connection, target);

    try {
      await this.authorize({ action: "join", channel: name, client: this.snapshot(entry) });
    } catch (error) {
      // A refused join must not leave a channel-less client behind.
      if (isNew) {
        this.release(entry);
      }

      throw error;
    }

    // Only created once both authorization checks passed, so a denied join never
    // leaves an empty channel behind.
    const roster = members ?? this.createChannel(name);
    entry.channels.add(name);
    roster.add(entry);

    if (isNew) {
      this.counters.connectionsAccepted += 1;
      this.emit({ name: "connect", clientId: entry.id });
    }

    this.emit({ name: "join", clientId: entry.id, channel: name });
    this.debug(
      { clientId: entry.id, channel: name, connections: this.clients.size },
      "Client joined",
    );

    return this.snapshot(entry);
  }

  /**
   * Unsubscribe a client from a channel.
   *
   * Unknown channels and unknown clients are safe no-ops returning `false`.
   * A channel that loses its last member is removed, and a client that holds no
   * channel anymore is released: it costs no slot, no heartbeat and no key.
   * Its socket is left open, so a client can subscribe again later.
   */
  async leave(channel: string, client: ClientRef | string): Promise<boolean> {
    const clientId = typeof client === "string" ? client : client.id;
    const name = typeof channel === "string" ? channel.trim() : "";
    const entry = this.clients.get(clientId);

    if (!entry || name.length === 0 || !entry.channels.has(name)) {
      return false;
    }

    const members = this.channels.get(name);
    entry.channels.delete(name);
    members?.delete(entry);

    if (members && members.size === 0) {
      this.channels.delete(name);
      this.counters.channelsRemoved += 1;
    }

    this.emit({ name: "leave", clientId, channel: name });

    if (entry.channels.size === 0) {
      this.release(entry);
    }

    return true;
  }

  /**
   * Leave every channel of a client, drop it from the hub and close the
   * connection. Returns `false` for an unknown client.
   */
  async disconnect(
    client: ClientRef | string,
    code = 1000,
    reason = "Client disconnected",
  ): Promise<boolean> {
    const clientId = typeof client === "string" ? client : client.id;
    const entry = this.clients.get(clientId);

    if (!entry) {
      return false;
    }

    for (const name of [...entry.channels]) {
      await this.leave(name, clientId);
    }

    this.release(entry);

    try {
      entry.connection.close(code, reason);
    } catch (error) {
      this.warn({ err: error, clientId }, "Failed to close connection");
    }

    this.emit({ name: "disconnect", clientId, reason });
    this.debug({ clientId }, "Client disconnected");
    return true;
  }

  // ------------------------------------------------------------------ delivery

  /**
   * Send a value to one client. Delivery problems never throw: a failing or slow
   * connection is counted, reported to the logger and `onEvent`, and skipped.
   *
   * @throws AuthorizationError when the authorize hook denies `send`.
   * @throws MessageTooLargeError when the encoded frame exceeds `maxMessageSize`.
   */
  async send(
    target: Client | ClientInput | Connection,
    message: unknown,
    options: BroadcastOptions = {},
  ): Promise<boolean> {
    return this.deliver(target, this.encodeForDelivery(message), options);
  }

  /** Send an already encoded frame. Useful for relays avoiding a re-encode. */
  async sendRaw(
    target: Client | ClientInput | Connection,
    payload: Uint8Array,
    options: BroadcastOptions = {},
  ): Promise<boolean> {
    return this.deliver(target, this.assertPayloadSize(payload), options);
  }

  /**
   * End-to-end encrypted send to one client.
   *
   * @throws ConnectionError when the target has no key registered.
   */
  async sendEncrypted(
    target: Client | ClientInput | Connection,
    message: unknown,
    options: BroadcastOptions = {},
  ): Promise<boolean> {
    return this.deliver(target, this.encrypt(target, message), options);
  }

  /**
   * Fan a value out to every member of a channel and return how many connections
   * were written to. One slow or broken member never affects the others.
   *
   * @throws AuthorizationError when the authorize hook denies `broadcast`.
   * @throws MessageTooLargeError when the encoded frame exceeds `maxMessageSize`.
   */
  async broadcast(
    channel: string,
    message: unknown,
    options: BroadcastOptions = {},
  ): Promise<number> {
    return this.fanOut(channel, this.encodeForDelivery(message), options);
  }

  async broadcastRaw(
    channel: string,
    payload: Uint8Array,
    options: BroadcastOptions = {},
  ): Promise<number> {
    return this.fanOut(channel, this.assertPayloadSize(payload), options);
  }

  /**
   * Fan a value out to every member of a channel as a per-recipient encrypted
   * frame, and return how many connections were written to.
   *
   * Members without a usable key are skipped rather than failed, so the count
   * is the number of clients that actually received a ciphertext. A hub without
   * E2EE has no keys at all, which would make every broadcast silently deliver
   * nothing, so that case is reported instead.
   *
   * @throws AuthorizationError when the authorize hook denies `broadcast`.
   * @throws ConnectionError when E2EE is not enabled on this hub.
   */
  async broadcastEncrypted(
    channel: string,
    message: unknown,
    options: BroadcastOptions = {},
  ): Promise<number> {
    if (!this.signingKeyPair) {
      // Without keys the loop below would skip every member and report 0, which
      // reads like an empty channel rather than the misconfiguration it is.
      throw new ConnectionError("E2EE is not enabled on this hub");
    }

    const payload = this.encodeForDelivery(message);

    // Every recipient needs its own ciphertext, so the frame is built per member.
    // Members without a registered key are skipped, not failed.
    return this.fanOut(
      channel,
      (member) => {
        const sharedKey = this.sharedKeyForMember(member);

        return sharedKey
          ? this.assertPayloadSize(this.encodeForDelivery(encryptFrame(payload, sharedKey)))
          : null;
      },
      options,
    );
  }

  // --------------------------------------------------------------- inspection

  /** Snapshot of a client, or `undefined` when unknown. */
  client(clientId: string): Client | undefined {
    const entry = this.clients.get(clientId);
    return entry ? this.snapshot(entry) : undefined;
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /** Member snapshots. Mutating the array or its clients cannot affect the hub. */
  participants(channel: string): Client[] {
    const members = this.channels.get(typeof channel === "string" ? channel.trim() : "");
    return members ? [...members].map((entry) => this.snapshot(entry)) : [];
  }

  hasChannel(channel: string): boolean {
    return this.channels.has(typeof channel === "string" ? channel.trim() : "");
  }

  channelNames(): string[] {
    return [...this.channels.keys()];
  }

  channelsFor(clientId: string): string[] {
    return [...(this.clients.get(clientId)?.channels ?? [])];
  }

  /** Member count of a channel; `0` when it does not exist. */
  channelCount(channel: string): number {
    return this.channels.get(typeof channel === "string" ? channel.trim() : "")?.size ?? 0;
  }

  /** Number of clients tracked by the hub. */
  clientCount(): number {
    return this.clients.size;
  }

  /** Total memberships across all channels. */
  totalSubscribers(): number {
    let total = 0;

    for (const members of this.channels.values()) {
      total += members.size;
    }

    return total;
  }

  /** Point-in-time counters. Nothing internal is handed out. */
  stats(): RealtimeHubStats {
    return {
      connections: this.clients.size,
      channels: this.channels.size,
      subscribers: this.totalSubscribers(),
      ...this.counters,
    };
  }

  // --------------------------------------------------------------------- e2ee

  get isE2EEEnabled(): boolean {
    return this.signingKeyPair !== null;
  }

  /** Server signing key pair clients must encrypt against. */
  get e2eePublicKey(): Buffer | null {
    return this.signingKeyPair
      ? Buffer.from(this.signingKeyPair.publicKey)
      : null;
  }

  /** Install the hub key pair. Prefer `createRealtimeHub({ e2ee: true })`. */
  setE2EEKeys(keyPair: KeyPair | null): void {
    this.signingKeyPair = keyPair
      ? {
          publicKey: Buffer.from(keyPair.publicKey),
          privateKey: Buffer.from(keyPair.privateKey),
        }
      : null;
  }

  /**
   * Register a client public key; returns the hub key it must encrypt with, or
   * `null` when E2EE is disabled.
   *
   * The key is validated here, at the boundary where untrusted input arrives.
   * A key of the wrong length used to be stored anyway and fail much later: every
   * message to that client was then skipped without an error, and a direct
   * `sendEncrypted()` threw a raw `RangeError` from inside libsodium.
   *
   * @throws TypeError when `publicKey` is not a Buffer. Use `fromBase64()` for a
   * key that arrives as text.
   * @throws RangeError when `publicKey` is not 32 bytes.
   */
  registerClientKey(client: ClientInput | Connection, publicKey: Buffer): Buffer | null {
    if (!this.signingKeyPair) {
      return null;
    }

    const connection = this.connectionOf(client);

    if (!connection) {
      return null;
    }

    assertClientPublicKey(publicKey);

    this.clientKeys.set(connection, Buffer.from(publicKey));
    return Buffer.from(this.signingKeyPair.publicKey);
  }

  removeClientKey(client: ClientInput | Connection): void {
    const connection = this.connectionOf(client);

    if (connection) {
      this.clientKeys.delete(connection);
    }
  }

  /**
   * Encrypt with the hub key and a registered client key.
   *
   * Returns `null` when the target has no key registered, which lets a caller
   * fall back to a plaintext frame instead of failing the whole batch.
   */
  encryptForClient(
    client: ClientInput | Connection,
    message: Uint8Array,
  ): Uint8Array | null {
    const sharedKey = this.sharedKeyFor(client);

    if (!sharedKey) {
      return null;
    }

    return encryptWithSharedKey(Buffer.from(message), sharedKey);
  }

  /** Decrypt a frame sent by a client with a registered key, else `null`. */
  decryptFromClient(
    client: ClientInput | Connection,
    frame: Uint8Array | E2EEFrame,
  ): Uint8Array | null {
    const connection = this.connectionOf(client);

    if (!connection) {
      return null;
    }

    const ciphertext = ciphertextOf(frame);

    if (!ciphertext) {
      return null;
    }

    // Server side of the shared secret: the client's public key with the hub's
    // private key, i.e. crypto_box_beforenm(clientPub, hubPriv).
    const sharedKey = this.deriveSharedKey(connection);

    if (!sharedKey) {
      return null;
    }

    try {
      return decryptWithSharedKey(ciphertext, sharedKey);
    } catch {
      this.debug({ clientId: this.clientIds.get(connection) }, "E2EE decrypt failed");
      return null;
    }
  }

  // ---------------------------------------------------------------- heartbeat

  /**
   * Start the shared heartbeat scheduler.
   *
   * One timer sweeps every connection, so cost does not scale with client count.
   * Idempotent, and ignored after `close()`.
   */
  startHeartbeat(options: Partial<HeartbeatOptions> = {}): void {
    if (this.closed || this.heartbeatTimer) {
      return;
    }

    const interval = { ...this.heartbeatOptions, ...options };
    positiveNumbers(interval, "heartbeat");

    this.heartbeatTimer = setInterval(() => this.sweep(), interval.intervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  get isHeartbeatRunning(): boolean {
    return this.heartbeatTimer !== null;
  }

  /**
   * Run one heartbeat pass: ping every connection that supports it, then close
   * the ones that missed their deadline.
   *
   * Public so transports without timers (and tests) can drive detection on their
   * own schedule.
   */
  sweep(): void {
    if (this.closed) {
      return;
    }

    const timeoutMs = this.heartbeatOptions.timeoutMs;
    const now = Date.now();
    const stale: ClientEntry[] = [];

    for (const entry of [...this.clients.values()]) {
      if (typeof entry.connection.ping !== "function") {
        continue;
      }

      if (entry.pingedAt !== 0 && now - entry.pingedAt > timeoutMs) {
        stale.push(entry);
        continue;
      }

      try {
        entry.connection.ping();
        entry.pingedAt = now;
        this.counters.heartbeatsSent += 1;
      } catch (error) {
        this.warn({ err: error, clientId: entry.id }, "Heartbeat ping failed");
        stale.push(entry);
      }
    }

    for (const entry of stale) {
      this.counters.connectionsTerminated += 1;
      this.recordDrop(entry.id, "heartbeat");
      void this.disconnect(entry.id, 1001, "Heartbeat timeout");
    }
  }

  /**
   * Mark a connection as alive, resetting its heartbeat deadline. A transport
   * without protocol-level pings can call this when it observes any traffic.
   */
  touch(clientId: string): boolean {
    const entry = this.clients.get(clientId);

    if (!entry) {
      return false;
    }

    entry.lastSeenAt = Date.now();
    entry.pingedAt = 0;
    return true;
  }

  // ------------------------------------------------------------------ private

  private assertOpen(): void {
    if (this.closed) {
      throw new ConnectionClosedError();
    }
  }

  private reject(reason: string): void {
    this.counters.connectionsRejected += 1;
    this.emit({ name: "reject", reason });
  }

  private validateChannelName(channel: unknown): string {
    if (typeof channel !== "string") {
      throw new ChannelError("Channel name must be a string");
    }

    const name = channel.trim();

    if (name.length === 0) {
      throw new ChannelError("Channel name must not be empty");
    }

    if (name.length > this.limits.maxChannelNameLength) {
      throw new ChannelError(
        `Channel name must be at most ${this.limits.maxChannelNameLength} characters`,
        { channel: name },
      );
    }

    if (CONTROL_CHARACTERS.test(name)) {
      throw new ChannelError("Channel name must not contain control characters", {
        channel: name,
      });
    }

    return name;
  }

  private createChannel(name: string): Set<ClientEntry> {
    const members = new Set<ClientEntry>();
    this.channels.set(name, members);
    return members;
  }

  private existingClient(
    connection: Connection,
    requestedId: string | undefined,
  ): ClientEntry | undefined {
    const mappedId = this.clientIds.get(connection);

    if (mappedId) {
      const mapped = this.clients.get(mappedId);

      if (mapped) {
        return mapped;
      }
    }

    if (requestedId) {
      const byId = this.clients.get(requestedId);

      if (byId && byId.connection !== connection) {
        throw new ConnectionError(`Client id "${requestedId}" is already in use`, {
          connectionId: requestedId,
        });
      }

      return byId;
    }

    return undefined;
  }

  private addClient(connection: Connection, target: ResolvedTarget): ClientEntry {
    const entry: ClientEntry = {
      id: target.id ?? randomUUID(),
      connection,
      channels: new Set(),
      metadata: { ...(target.metadata ?? {}) },
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
      pingedAt: 0,
      consecutiveDrops: 0,
    };

    this.clients.set(entry.id, entry);
    this.clientIds.set(connection, entry.id);
    return entry;
  }

  /** Remove a client from every channel and forget it entirely. */
  private release(entry: ClientEntry): void {
    for (const name of entry.channels) {
      const members = this.channels.get(name);
      members?.delete(entry);

      if (members && members.size === 0) {
        this.channels.delete(name);
        this.counters.channelsRemoved += 1;
      }
    }

    entry.channels.clear();
    this.clients.delete(entry.id);
    this.clientIds.delete(entry.connection);
    this.clientKeys.delete(entry.connection);
  }

  private snapshot(entry: ClientEntry): Client {
    return Object.freeze({
      id: entry.id,
      connection: entry.connection,
      metadata: Object.freeze({ ...entry.metadata }),
      joinedAt: entry.joinedAt,
      lastSeenAt: entry.lastSeenAt,
      channels: new Set(entry.channels),
    });
  }

  private async authorize(context: AuthorizeContext): Promise<void> {
    if (!this.authorizeHook) {
      return;
    }

    let allowed: boolean | void;

    try {
      allowed = await this.authorizeHook({
        action: context.action,
        channel: context.channel,
        client: context.client,
        metadata: context.client?.metadata ?? context.metadata,
      });
    } catch (error) {
      allowed = false;
      this.debug({ err: error, action: context.action }, "Authorize hook threw");
    }

    if (allowed !== false) {
      return;
    }

    this.counters.authorizationsDenied += 1;
    this.emit({
      name: "reject",
      channel: context.channel,
      clientId: context.client?.id,
      reason: context.action,
    });
    this.debug({ action: context.action, channel: context.channel }, "Authorization denied");

    throw new AuthorizationError(context.action);
  }

  private encodeForDelivery(message: unknown): Uint8Array {
    return this.assertPayloadSize(encodePayload(message));
  }

  private assertPayloadSize(payload: Uint8Array): Uint8Array {
    if (payload.byteLength > this.limits.maxMessageSize) {
      throw new MessageTooLargeError(payload.byteLength, this.limits.maxMessageSize);
    }

    return payload;
  }

  /**
   * Encrypt a frame for one client.
   *
   * The wire format is `{ type: "e2ee", ciphertext }` with Base64 ciphertext, so a
   * client can tell an encrypted frame from a plaintext one.
   *
   * @throws ConnectionError when E2EE is disabled or the target has no key.
   */
  private encrypt(
    target: Client | ClientInput | Connection | null,
    message: unknown,
  ): Uint8Array {
    const payload = this.encodeForDelivery(message);
    const sharedKey = this.sharedKeyFor(target);

    if (!this.signingKeyPair) {
      throw new ConnectionError("E2EE is not enabled on this hub");
    }

    if (!sharedKey) {
      throw new ConnectionError(
        "No E2EE key is registered for the target; call registerClientKey() first",
      );
    }

    return this.encodeForDelivery(encryptFrame(payload, sharedKey));
  }

  /**
   * Derive the shared key for a connection, or `null` when there is not a usable
   * one.
   *
   * Deriving is the one step that can throw for reasons the caller cannot act on,
   * so a failure becomes "no key" rather than an exception escaping a delivery
   * path. A `null` is visible: `encryptForClient()` and `decryptFromClient()`
   * return it, and a broadcast reports the member as undelivered.
   */
  private deriveSharedKey(connection: Connection | null): Buffer | null {
    if (!connection || !this.signingKeyPair) {
      return null;
    }

    const clientKey = this.clientKeys.get(connection);

    if (!clientKey) {
      return null;
    }

    try {
      return computeSharedKey(clientKey, this.signingKeyPair.privateKey);
    } catch (error) {
      this.warn(
        { err: error, clientId: this.clientIds.get(connection) },
        "E2EE shared key derivation failed; treating the client as unkeyed",
      );
      return null;
    }
  }

  /** Shared key for anything addressable, or `null` when it registered no key. */
  private sharedKeyFor(
    target: Client | ClientInput | Connection | null,
  ): Buffer | null {
    if (!target) {
      return null;
    }

    return this.deriveSharedKey(this.connectionOf(target));
  }

  /** Shared key for a known member, or `null` when it registered no key. */
  private sharedKeyForMember(member: ClientEntry): Buffer | null {
    return this.deriveSharedKey(member.connection);
  }

  private connectionOf(target: ClientInput | Connection | Client): Connection | null {
    if (isConnection(target)) {
      const id = this.clientIds.get(target);
      return id && this.clients.has(id) ? target : null;
    }

    const connection = (target as ClientInput).connection;

    if (!isConnection(connection)) {
      return null;
    }

    const id = this.clientIds.get(connection);

    if (id) {
      return this.clients.has(id) ? connection : null;
    }

    return (target as ClientInput).id && this.clients.has(target.id as string)
      ? connection
      : null;
  }

  private entryOf(target: Client | ClientInput | Connection): ClientEntry | undefined {
    const connection = this.connectionOf(target);
    const id = connection ? this.clientIds.get(connection) : undefined;
    return id ? this.clients.get(id) : undefined;
  }

  private async deliver(
    target: Client | ClientInput | Connection,
    payload: Uint8Array,
    options: BroadcastOptions,
  ): Promise<boolean> {
    const entry = this.entryOf(target);

    if (entry) {
      await this.authorize({ action: "send", client: this.snapshot(entry) });
    }

    const connection = this.connectionOf(target);

    if (!connection) {
      this.warn({}, "Cannot resolve a connection for the target");
      return false;
    }

    return this.write(connection, entry, payload, options.metadata);
  }

  private async fanOut(
    channel: string,
    payload: FrameFactory | Uint8Array,
    options: BroadcastOptions,
  ): Promise<number> {
    this.assertOpen();

    const name = typeof channel === "string" ? channel.trim() : "";
    const members = this.channels.get(name);

    if (!members || members.size === 0) {
      return 0;
    }

    await this.authorize({ action: "broadcast", channel: name });

    const include = options.include ? new Set(options.include) : null;
    const exclude = options.exclude ? new Set(options.exclude) : null;
    let delivered = 0;

    for (const member of [...members]) {
      if (!this.isCurrentMember(member, name, include, exclude)) {
        continue;
      }

      if (options.authorizeRecipients === true) {
        try {
          await this.authorize({
            action: "send",
            channel: name,
            client: this.snapshot(member),
          });
        } catch {
          continue;
        }
      }

      const frame =
        typeof payload === "function" ? this.buildFrame(payload, member) : payload;

      if (!frame) {
        continue;
      }

      if (this.write(member.connection, member, frame, options.metadata)) {
        delivered += 1;
      }
    }

    this.counters.broadcasts += 1;
    this.emit({ name: "broadcast", channel: name, metadata: options.metadata });
    return delivered;
  }

  /** Build a per-recipient frame, isolating a single recipient's failure. */
  private buildFrame(factory: FrameFactory, member: ClientEntry): Uint8Array | null {
    try {
      return factory(member);
    } catch (error) {
      this.counters.messagesDropped += 1;
      this.warn({ err: error, clientId: member.id }, "Skipped a client frame");
      this.recordDrop(member.id, "encode-failed");
      return null;
    }
  }

  /** A member is stale when it was released or no longer holds this channel. */
  private isCurrentMember(
    member: ClientEntry,
    name: string,
    include: Set<string> | null,
    exclude: Set<string> | null,
  ): boolean {
    if (this.clients.get(member.id) !== member || !member.channels.has(name)) {
      this.channels.get(name)?.delete(member);
      return false;
    }

    if (include && !include.has(member.id)) {
      return false;
    }

    return !exclude?.has(member.id);
  }

  /**
   * Write one frame to one connection.
   *
   * Never throws: a closed, slow or failing connection is dropped or terminated
   * and the hub keeps serving everyone else. Returns whether the frame was
   * handed to the transport.
   */
  private write(
    connection: Connection,
    entry: ClientEntry | undefined,
    payload: Uint8Array,
    metadata?: Record<string, unknown>,
  ): boolean {
    const clientId = entry?.id ?? this.clientIds.get(connection);

    if (connection.readyState !== CONNECTION_OPEN) {
      this.recordDrop(clientId, "closed");
      return false;
    }

    const buffered = connection.bufferedAmount;

    if (
      entry &&
      typeof buffered === "number" &&
      buffered > this.backpressure.maxBufferedBytes
    ) {
      entry.consecutiveDrops += 1;

      if (entry.consecutiveDrops >= this.backpressure.maxConsecutiveDrops) {
        this.counters.connectionsTerminated += 1;
        this.recordDrop(clientId, "backpressure");
        this.warn({ clientId, buffered }, "Terminating slow connection");
        void this.disconnect(clientId as string, 1013, "Backpressure limit exceeded");
        return false;
      }

      this.recordDrop(clientId, "backpressure");
      this.debug({ clientId, buffered }, "Skipping write to slow connection");
      return false;
    }

    try {
      connection.send(payload);
    } catch (error) {
      this.counters.sendFailures += 1;
      this.counters.connectionsTerminated += 1;
      this.warn({ err: error, clientId }, "Realtime delivery failed");
      this.recordDrop(clientId, "send-failed");

      try {
        connection.terminate?.();
      } catch {
        // The transport is already broken; nothing further to do.
      }

      if (clientId) {
        void this.disconnect(clientId, 1011, "Delivery failed");
      }

      return false;
    }

    if (entry) {
      entry.consecutiveDrops = 0;
    }

    this.counters.messagesSent += 1;
    this.emit({ name: "send", clientId, channel: entry?.channels.size === 1 ? [...entry.channels][0] : undefined, metadata });
    return true;
  }

  private recordDrop(clientId: string | undefined, reason: string): void {
    this.counters.messagesDropped += 1;
    this.emit({ name: "drop", clientId, reason });
  }

  private emit(event: Omit<RealtimeEvent, "at">): void {
    if (!this.eventHook) {
      return;
    }

    try {
      this.eventHook({ ...event, at: Date.now() });
    } catch (error) {
      this.warn({ err: error }, "onEvent hook threw");
    }
  }

  private debug(payload: unknown, message: string): void {
    this.logger?.debug?.(payload, message);
  }

  private warn(payload: unknown, message: string): void {
    this.logger?.warn?.(payload, message);
  }
}

export interface CreateRealtimeHubOptions extends RealtimeHubOptions {
  /** Generate a hub key pair and enable E2EE, awaiting libsodium readiness first. */
  e2ee?: boolean;
}

/**
 * Async factory. Use it when E2EE is enabled, so libsodium readiness is awaited
 * before the first encrypted frame.
 */
export async function createRealtimeHub(
  options: CreateRealtimeHubOptions = {},
): Promise<RealtimeHub> {
  const { e2ee, ...rest } = options;
  const hub = new RealtimeHub(rest);

  if (e2ee) {
    await e2eeReady();
    hub.setE2EEKeys(generateKeyPair());
  }

  return hub;
}