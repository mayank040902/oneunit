import { BaseTransport } from '@/transport/transport';
import { TransportHealth, StreamTransport, DuplexStream, TransportMetrics } from '@/core/capabilities';
import { TcpFrameParser } from './frame-parser.js';
import { Logger, noopLogger } from '@/observability/logger.js';
import { resolveSecurity, createSecuredDispatcher } from '@/core/secured-dispatcher.js';
import type { ResolvedSecurity } from '@/core/secured-dispatcher.js';
import type { SecuredRequestContext } from '@/core/secured-dispatcher.js';
import type { RpcContext, RpcMethodHandler } from '@/core/capabilities.js';
import { createMicroserviceError, ErrorCodes } from '@/core/errors.js';
import type { ServiceCredentials } from '@/identity/credentials.js';
import type * as net from 'net';
import type * as tls from 'tls';
import { readFileSync } from 'node:fs';

export interface TcpConfig {
  host: string;
  port: number;
  tls?: boolean;
  cert?: string;
  key?: string;
  ca?: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  maxFrameSize?: number;
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
  connectionTimeout?: number;
  idleTimeout?: number;
  logger?: Logger;
}

export interface TcpConnection extends DuplexStream {
  remoteAddress: string;
  remotePort: number;
}

export interface ParsedRemote {
  host: string;
  port: number;
}

export function parseRemote(remote: string): ParsedRemote {
  if (remote.startsWith('[')) {
    const closeBracket = remote.indexOf(']');
    if (closeBracket === -1) {
      throw new Error(`Invalid remote address format: ${remote}`);
    }
    const host = remote.slice(1, closeBracket);
    const rest = remote.slice(closeBracket + 1);
    if (!rest.startsWith(':')) {
      throw new Error(`Invalid remote address format: ${remote}`);
    }
    const port = parseInt(rest.slice(1), 10);
    if (isNaN(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid remote address format: ${remote}`);
    }
    return { host, port };
  }

  const lastColon = remote.lastIndexOf(':');
  if (lastColon === -1) {
    throw new Error(`Invalid remote address format: ${remote}`);
  }
  const host = remote.slice(0, lastColon);
  const portStr = remote.slice(lastColon + 1);
  const port = parseInt(portStr, 10);
  if (!portStr || isNaN(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid remote address format: ${remote}`);
  }
  return { host, port };
}

export class TcpTransport extends BaseTransport implements StreamTransport {
  private config: TcpConfig;
  private logger: Logger;
  private securityInput: unknown;
  private server: net.Server | tls.Server | null = null;
  private methodHandlers: Map<string, Map<string, RpcMethodHandler>> = new Map();
  private securedDispatcherInstance: ReturnType<typeof createSecuredDispatcher> | null = null;

  private getSecuredDispatcher() {
    if (this.securedDispatcherInstance) return this.securedDispatcherInstance;
    const resolved = resolveSecurity(this.config, this.securityInput, this) as ResolvedSecurity;
    if (!resolved.protected) return null;
    const dispatcher = resolved.dispatcher ?? (resolved.options ? createSecuredDispatcher(resolved.options) : null);
    this.securedDispatcherInstance = dispatcher;
    return dispatcher;
  }

  private connections: Map<string, TcpConnection> = new Map();
  private metrics: TransportMetrics;

  constructor(config: TcpConfig, security?: unknown) {
    super({
      name: 'tcp',
      capabilities: {
        requestResponse: true,
        streaming: true,
        publishSubscribe: false,
        durableDelivery: false,
        orderedDelivery: true,
        bidirectional: true,
      },
    });
    this.config = config;
    this.securityInput = security;
    this.logger = config.logger ?? noopLogger;
    this.metrics = this.createEmptyMetrics();
  }

  async start(): Promise<void> {
    if (this.isStarted() && this.server) {
      return;
    }

    const { createServer } = await import('net');
    const { createServer: createTlsServer } = await import('tls');

    if (this.config.tls) {
      if (!this.config.cert || !this.config.key) {
        throw new Error('TLS requires cert and key');
      }
      const serverOptions: tls.TlsOptions = {
        cert: readFileSync(this.config.cert),
        key: readFileSync(this.config.key),
        rejectUnauthorized: this.config.rejectUnauthorized ?? true,
      };
      if (this.config.ca) {
        serverOptions.ca = readFileSync(this.config.ca);
        serverOptions.requestCert = this.config.requestCert ?? true;
        serverOptions.rejectUnauthorized = this.config.rejectUnauthorized ?? true;
        if (serverOptions.rejectUnauthorized === false) {
          this.logger.warn('TCP TLS client certificate verification is disabled');
        }
      }
      if (!this.config.ca && this.config.requestCert) {
        serverOptions.requestCert = true;
      }
      this.server = createTlsServer(serverOptions, this.handleConnection.bind(this));
    } else {
      this.server = createServer(this.handleConnection.bind(this));
    }

    this.server.on('error', (err: Error) => {
      this.metrics.errors++;
      this.logger.error(err, 'TCP server error');
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onListenError = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      this.server!.once('error', onListenError);
      this.server!.listen(this.config.port, this.config.host, () => {
        if (settled) return;
        settled = true;
        this.server!.removeListener('error', onListenError);
        resolve();
      });
      if (this.config.connectionTimeout) {
        setTimeout(() => {
          if (!settled) {
            settled = true;
            this.server?.removeListener('error', onListenError);
            try {
              this.server?.close();
            } catch { void 0; }
            reject(new Error(`TCP server startup timed out after ${this.config.connectionTimeout}ms`));
          }
        }, this.config.connectionTimeout).unref();
      }
    });

    this.started = true;
  }

  async close(): Promise<void> {
    if (this.closedState) {
      this.started = false;
      return;
    }
    this.closedState = true;

    for (const [remote, conn] of Array.from(this.connections.entries())) {
      try {
        await conn.close();
      } catch { void 0; }
      this.connections.delete(remote);
    }
    this.connections.clear();

    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close((err?: Error) => {
          if (err) {
            this.logger.error(err, 'TCP server close error');
          }
          resolve();
        });
      });
    }

    this.started = false;
  }

  get isClosed(): boolean {
    return this.closedState;
  }

  private closedState = false;

  async healthCheck(): Promise<TransportHealth> {
    return {
      status: this.isStarted() ? 'healthy' : 'unhealthy',
      checkedAt: Date.now(),
      details: {
        connections: this.connections.size,
        ...this.metrics,
      },
    };
  }

  async openStream(remote: string): Promise<DuplexStream> {
    if (!this.started || !this.server) {
      throw new Error('TCP transport not started');
    }
    const { connect } = await import('net');
    const { connect: tlsConnect } = await import('tls');

    const { host, port } = parseRemote(remote);

    let settled = false;
    const finishReject = (reject: (reason?: unknown) => void, err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const finishResolve = (resolve: (value: DuplexStream) => void, value: DuplexStream) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const options: net.NetConnectOpts & tls.ConnectionOptions = { host, port };
    if (this.config.tls) {
      if (!this.config.cert || !this.config.key) {
        throw new Error('TLS requires cert and key');
      }
      options.cert = readFileSync(this.config.cert);
      options.key = readFileSync(this.config.key);
      if (this.config.ca) {
        options.ca = readFileSync(this.config.ca);
      }
      options.rejectUnauthorized = this.config.rejectUnauthorized ?? true;
    }

    return new Promise<DuplexStream>((resolve, reject) => {
      const socket: net.Socket = this.config.tls
        ? (tlsConnect(options) as net.Socket)
        : (connect(options) as net.Socket);
      const cleanupTimer = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };

      const onConnect = () => {
        cleanupTimer();
        socket.setTimeout(0);
        const conn = this.createConnection(socket, remote);
        this.connections.set(remote, conn);
        finishResolve(resolve, conn);
      };
      const onError = (err: Error) => {
        cleanupTimer();
        socket.destroy();
        finishReject(reject, err);
      };
      const onClose = () => {
        cleanupTimer();
        finishReject(reject, new Error('Connection closed'));
      };

      socket.on('connect', onConnect);
      socket.on('error', onError);
      socket.on('close', onClose);

      let timeoutHandle: NodeJS.Timeout | null = null;
      if (this.config.connectionTimeout) {
        timeoutHandle = setTimeout(() => {
          socket.destroy();
          finishReject(reject, new Error(`TCP connection timed out after ${this.config.connectionTimeout}ms`));
        }, this.config.connectionTimeout);
        timeoutHandle.unref();
      }
    });
  }

  private handleConnection(socket: net.Socket): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    const conn = this.createConnection(socket, remote);
    this.connections.set(remote, conn);
  }

  private createConnection(socket: net.Socket, remote: string): TcpConnection {
    const maxFrameSize = this.config.maxFrameSize ?? 16 * 1024 * 1024;
    const idleTimeout = this.config.idleTimeout;
    const parser = new TcpFrameParser({ maxFrameSize });
    const frameQueue: Uint8Array[] = [];
    const readers: Array<(value: Uint8Array | null) => void> = [];
    const maxQueuedFrames = this.config.maxQueuedFrames ?? 128;
    const maxQueuedBytes = this.config.maxQueuedBytes ?? Math.max(maxFrameSize, 1024 * 1024);
    const highWaterFrames = Math.max(1, Math.floor(maxQueuedFrames * 0.75));
    const lowWaterFrames = Math.max(0, Math.floor(maxQueuedFrames * 0.25));
    const logger = this.logger;
    let closed = false;
    let cleanupDone = false;
    let paused = false;
    let queuedBytes = 0;
    let idleTimer: NodeJS.Timeout | null = null;

    const removeConnection = () => {
      this.connections.delete(remote);
    };

    const cleanup = () => {
      if (cleanupDone) return;
      cleanupDone = true;
      closed = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      while (readers.length > 0) {
        const resolveReader = readers.shift()!;
        resolveReader(null);
      }
      frameQueue.length = 0;
      queuedBytes = 0;
      removeConnection();
      try {
        socket.destroy();
      } catch { void 0; }
    };

    const onData = (chunk: Buffer) => {
      if (closed) return;
      let result: { frames: Uint8Array[]; error: Error | null };
      try {
        result = parser.feed(chunk) as { frames: Uint8Array[]; error: Error | null };
      } catch {
        cleanup();
        return;
      }
      for (const frame of result.frames) {
        const data = new Uint8Array(frame);
        if (closed) break;
        if (
          (frameQueue.length >= maxQueuedFrames || queuedBytes + data.length > maxQueuedBytes) &&
          readers.length === 0
        ) {
          closed = true;
          queuedBytes = 0;
          frameQueue.length = 0;
          logger.error(new Error('TCP connection backpressure limit reached'), 'TCP connection dropped');
          this.metrics.errors++;
          cleanup();
          return;
        }
        this.metrics.bytesReceived += data.length + 4;
        this.metrics.messagesReceived++;
        if (readers.length > 0) {
          const resolveReader = readers.shift()!;
          resolveReader(data);
        } else {
          frameQueue.push(data);
          queuedBytes += data.length;
        }
        void this.dispatchRawFrame(conn, frame).catch((err: unknown) => {
          this.metrics.errors++;
          logger.error(err instanceof Error ? err : new Error(String(err)), 'TCP raw frame dispatch failed');
        });
      }
      if (result.error) {
        closed = true;
        this.metrics.errors++;
        cleanup();
        return;
      }
      if (!closed && frameQueue.length >= highWaterFrames) {
        try {
          socket.pause();
          paused = true;
        } catch { void 0; }
      }
    };

    const onClose = () => {
      cleanup();
    };

    const onError = (err: Error) => {
      this.metrics.errors++;
      logger.error(err, 'TCP socket error');
      cleanup();
    };

    const onTimeout = () => {
      this.metrics.errors++;
      logger.warn('TCP idle timeout', { remote });
      cleanup();
    };

    if (idleTimeout && typeof socket.setTimeout === 'function') {
      socket.setTimeout(idleTimeout);
      socket.on('timeout', onTimeout);
    }

    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('error', onError);

    const conn: TcpConnection = {
      remoteAddress: socket.remoteAddress ?? 'unknown',
      remotePort: socket.remotePort ?? 0,

      write: async (data: Uint8Array) => {
        if (closed) {
          throw new Error('Connection is closed');
        }
        if (data.length > maxFrameSize) {
          throw new Error(`Frame size ${data.length} exceeds maximum ${maxFrameSize}`);
        }
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length, 0);
        const outgoing = Buffer.concat([length, Buffer.from(data)]);

        const ok = socket.write(outgoing);
        this.metrics.bytesSent += data.length + 4;
        this.metrics.messagesSent++;

        if (ok) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            cleanupListeners();
            resolve();
          };
          const onFail = (err: Error) => {
            cleanupListeners();
            reject(err);
          };
          const cleanupListeners = () => {
            socket.removeListener('drain', onDrain);
            socket.removeListener('error', onFail);
            socket.removeListener('close', onFail);
          };
          socket.on('drain', onDrain);
          socket.on('error', onFail);
          socket.on('close', onFail);
        });

        if (closed) {
          throw new Error('Connection is closed');
        }
      },

      read: async () => {
        if (frameQueue.length > 0) {
          const value = frameQueue.shift()!;
          queuedBytes -= value.length;
          if (paused && frameQueue.length <= lowWaterFrames) {
            paused = false;
            try {
              socket.resume();
            } catch { void 0; }
          }
          return value;
        }
        if (closed) {
          return null;
        }
        return new Promise<Uint8Array | null>((resolve) => {
          readers.push(resolve);
        });
      },

      close: async () => {
        cleanup();
      },
    };

    socket.once('close', removeConnection);
    return conn;
  }

  registerMethod(service: string, method: string, handler: RpcMethodHandler): void {
    if (!this.methodHandlers.has(service)) {
      this.methodHandlers.set(service, new Map());
    }
    this.methodHandlers.get(service)!.set(method, handler);
  }

  unregisterMethod(service: string, method: string): void {
    this.methodHandlers.get(service)?.delete(method);
  }

  async handle(service: string, method: string, input: unknown, context: unknown): Promise<unknown> {
    const handlers = this.methodHandlers.get(service);
    const handler = handlers?.get(method);
    if (!handler) {
      throw createMicroserviceError(
        ErrorCodes.NOT_FOUND,
        `Method ${service}.${method} not found`,
        'NOT_FOUND',
        false,
        { details: { service, method } }
      );
    }
    const rpcContext = (context as RpcContext) ?? {
      serviceId: service,
      correlationId: crypto.randomUUID(),
      headers: {},
      metadata: new Map(),
    };
    const dispatcher = this.getSecuredDispatcher();
    const metadata = rpcContext.metadata instanceof Map ? rpcContext.metadata : new Map(Object.entries(rpcContext.metadata ?? {}));
    rpcContext.metadata = metadata;
    const request: SecuredRequestContext = {
      service,
      method,
      transport: 'tcp',
      operation: `${service}.${method}`,
      targetService: service,
      credentials: metadata.get('credentials') as ServiceCredentials | undefined,
      metadata,
      attributes: {},
      correlationId: rpcContext.correlationId,
    };
    const run = () => {
      if (request.principal && metadata) {
        metadata.set('principal', request.principal);
        metadata.set('authenticatedPrincipal', request.principal);
      }
      if (request.caller && metadata) {
        metadata.set('caller', request.caller);
      }
      return handler(input, rpcContext);
    };
    if (!dispatcher) {
      return run();
    }
    return dispatcher.dispatch(request, run);
  }

  private async dispatchRawFrame(conn: TcpConnection, frame: Uint8Array | Buffer): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(frame).toString('utf8'));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;

    let request = parsed as Record<string, unknown>;
    const originalPayload = request['payload'];
    if (originalPayload && typeof originalPayload === 'object' && !Array.isArray(originalPayload)) {
      const payload = originalPayload as Record<string, unknown>;
      if ('service' in payload || 'serviceId' in payload || 'svc' in payload || 'method' in payload || 'methodName' in payload) {
        request = payload;
      }
    }

    const type = request['type'];
    const isControl = type === 'control' || type === 'ping' || type === 'pong' || type === 'heartbeat' || type === 'hello' ||
      request['control'] === true || request['ping'] === true;
    if (isControl) {
      const id = request['id'] ?? request['requestId'] ?? request['messageId'];
      if (id !== undefined) {
        try {
          await conn.write(Buffer.from(JSON.stringify({ id, ok: true, type: 'pong' })));
        } catch { void 0; }
      }
      return;
    }

    let service = request['service'] ?? request['serviceId'] ?? request['svc'] ?? request['target'] ?? request['targetService'];
    let method = request['method'] ?? request['methodName'] ?? request['method_name'] ?? request['op'] ?? request['operation'];
    if (typeof method === 'string' && method.includes('.') && (typeof service !== 'string' || service === '')) {
      const parts = method.split('.', 2);
      service = parts[0];
      method = parts[1];
    }
    if (typeof service !== 'string' || typeof method !== 'string' || !service.trim() || !method.trim()) {
      return;
    }

    const inputCandidate = request['input'] ?? request['params'] ?? request['args'] ?? request['data'] ?? request['body'] ?? request['request'] ?? request['value'];
    const input = (inputCandidate === undefined && !('service' in request) && !('method' in request)) ? request : (inputCandidate === undefined ? undefined : inputCandidate);

    const correlationId = (request['correlationId'] ?? request['correlation_id'] ?? request['correlation']) as string | undefined;
    const credsFromInput = (input && typeof input === 'object' && !Array.isArray(input))
      ? ((input as Record<string, unknown>)['credentials'] ?? (input as Record<string, unknown>)['creds'])
      : undefined;
    const credentials = request['credentials'] ?? request['creds'] ?? request['credential'] ?? request['auth'] ?? request['authentication'] ?? request['token'] ??
      credsFromInput ??
      (request['metadata'] as Record<string, unknown> | undefined)?.['credentials'] ??
      (request['headers'] as Record<string, unknown> | undefined)?.['credentials'];

    const metadata = new Map<string, unknown>();
    const rawMetadata = request['metadata'];
    if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
      for (const [k, v] of Object.entries(rawMetadata)) metadata.set(k, v);
    }
    if (credentials !== undefined) metadata.set('credentials', credentials);
    const rawHeaders = request['headers'];
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders)) metadata.set(k, v);
    }
    const rpcContext = {
      serviceId: service,
      correlationId: (correlationId && typeof correlationId === 'string') ? correlationId : crypto.randomUUID(),
      headers: (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) ? rawHeaders as Record<string, unknown> : {},
      metadata,
    };

    const id = request['id'] ?? request['requestId'] ?? request['messageId'] ?? request['request_id'];

    try {
      const result = await this.handle(service, method, input, rpcContext as unknown as RpcContext);
      const __resp = Buffer.from(JSON.stringify({ id, ok: true, result }));
      try {
        await conn.write(__resp);
      } catch { void 0; }
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      try {
        await conn.write(Buffer.from(JSON.stringify({ id, ok: false, error: { code: e?.code ?? 'INTERNAL', message: e?.message ?? String(err) } })));
      } catch { void 0; }
    }
  }

  getMetrics(): TransportMetrics {
    return { ...this.metrics };
  }

  private createEmptyMetrics(): TransportMetrics {
    return {
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      errors: 0,
      latencyMs: { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 },
    };
  }
}

export function createTcpTransport(config: TcpConfig): TcpTransport {
  return new TcpTransport(config);
}
