import { BaseTransport } from '@/transport/transport';
import { TransportHealth, StreamTransport, DuplexStream, TransportMetrics } from '@/core/capabilities';
import { TcpFrameParser } from './frame-parser.js';
import type * as net from 'net';
import type * as tls from 'tls';

export interface TcpConfig {
  host: string;
  port: number;
  tls?: boolean;
  cert?: string;
  key?: string;
  ca?: string;
  maxFrameSize?: number;
  connectionTimeout?: number;
  idleTimeout?: number;
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
  // Handle bracketed IPv6 literals: [::1]:9000
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

  // For non-bracketed addresses, split on the last colon to support IPv6
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
  private server: net.Server | null = null;
  private connections: Map<string, TcpConnection> = new Map();
  private metrics: TransportMetrics;

  constructor(config: TcpConfig) {
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
    this.metrics = this.createEmptyMetrics();
  }

  async start(): Promise<void> {
    const { createServer } = await import('net');
    const { createServer: createTlsServer } = await import('tls');
    const { readFileSync } = await import('fs');

    const serverOptions: tls.TlsOptions = {};

    if (this.config.tls) {
      if (!this.config.cert || !this.config.key) {
        throw new Error('TLS requires cert and key');
      }
      serverOptions.cert = readFileSync(this.config.cert);
      serverOptions.key = readFileSync(this.config.key);
      if (this.config.ca) {
        serverOptions.ca = readFileSync(this.config.ca);
        serverOptions.requestCert = true;
        serverOptions.rejectUnauthorized = true;
      }
      this.server = createTlsServer(serverOptions, this.handleConnection.bind(this));
    } else {
      this.server = createServer(this.handleConnection.bind(this));
    }

    this.server!.on('error', (err: Error) => {
      this.metrics.errors++;
      console.error('TCP server error:', err);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.started = true;
  }

  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.close();
    }
    this.connections.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close((err?: Error) => {
          if (err) {
            console.error('TCP server close error:', err);
          }
          resolve();
        });
      });
    }

    this.started = false;
  }

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
    if (!this.started) {
      throw new Error('TCP transport not started');
    }
    const { connect } = await import('net');
    const { connect: tlsConnect } = await import('tls');

    const { host, port } = parseRemote(remote);

    const options: net.NetConnectOpts & tls.ConnectionOptions = { host, port };
    if (this.config.tls) {
      options.cert = this.config.cert;
      options.key = this.config.key;
      options.ca = this.config.ca;
    }

    return new Promise((resolve, reject) => {
      const socket: net.Socket = this.config.tls ? tlsConnect(options) : connect(options);
      
      socket.on('connect', () => {
        socket.setTimeout(0);
        const conn = this.createConnection(socket, remote);
        this.connections.set(remote, conn);
        resolve(conn);
      });
      
      socket.on('error', reject);
      
      if (this.config.connectionTimeout) {
        socket.setTimeout(this.config.connectionTimeout, () => {
          socket.destroy();
          reject(new Error('Connection timeout'));
        });
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
    const readQueue: Array<(value: Uint8Array | null) => void> = [];
    let closed = false;

    if (idleTimeout && typeof socket.setTimeout === 'function') {
      socket.setTimeout(idleTimeout, () => {
        socket.destroy();
        this.connections.delete(remote);
        this.metrics.errors++;
      });
    }

    const drainQueue = (value: Uint8Array | null) => {
      while (readQueue.length > 0) {
        const resolve = readQueue.shift()!;
        resolve(value);
      }
    };

    const onData = (chunk: Buffer) => {
      const result = parser.feed(chunk);
      for (const frame of result.frames) {
        this.metrics.bytesReceived += frame.length + 4;
        this.metrics.messagesReceived++;
        if (readQueue.length > 0) {
          const resolve = readQueue.shift()!;
          resolve(new Uint8Array(frame));
        }
      }
      if (result.error) {
        closed = true;
        drainQueue(null);
        socket.destroy();
      }
    };

    const onClose = () => {
      closed = true;
      drainQueue(null);
    };

    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onClose);

    const conn: TcpConnection = {
      remoteAddress: socket.remoteAddress ?? 'unknown',
      remotePort: socket.remotePort ?? 0,

      write: async (data: Uint8Array) => {
        if (closed) {
          throw new Error('Connection is closed');
        }
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length, 0);
        socket.write(Buffer.concat([length, Buffer.from(data)]));
        this.metrics.bytesSent += data.length + 4;
        this.metrics.messagesSent++;
      },

      read: async () => {
        return new Promise<Uint8Array | null>((resolve) => {
          readQueue.push(resolve);
        });
      },

      close: async () => {
        if (!closed) {
          closed = true;
          socket.off('data', onData);
          socket.off('close', onClose);
          socket.off('error', onClose);
          socket.destroy();
        }
        this.connections.delete(remote);
      },
    };

    return conn;
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