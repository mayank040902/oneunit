import { BaseTransport, TransportConfig } from '@/transport/transport';
import { TransportCapabilities, TransportHealth, StreamTransport, DuplexStream, TransportMetrics } from '@/core/capabilities';

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

export class TcpTransport extends BaseTransport implements StreamTransport {
  private config: TcpConfig;
  private server: any;
  private connections: Map<string, TcpConnection> = new Map();
  private frameBuffer: Map<string, Uint8Array> = new Map();
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

    const serverOptions: any = {};

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

    this.server.on('error', (err: Error) => {
      this.metrics.errors++;
      console.error('TCP server error:', err);
    });

    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, (err?: Error) => {
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
        this.server.close(resolve);
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
    const { connect } = await import('net');
    const { connect: tlsConnect } = await import('tls');

    const [host, portStr] = remote.split(':');
    const port = portStr ? parseInt(portStr, 10) : 0;
    if (!portStr || isNaN(port)) {
      throw new Error(`Invalid remote address format: ${remote}`);
    }

    const options: any = { host, port };
    if (this.config.tls) {
      options.cert = this.config.cert;
      options.key = this.config.key;
      options.ca = this.config.ca;
    }

    return new Promise((resolve, reject) => {
      const socket = this.config.tls ? tlsConnect(options) : connect(options);
      
      socket.on('connect', () => {
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

  private handleConnection(socket: any): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    const conn = this.createConnection(socket, remote);
    this.connections.set(remote, conn);
  }

  private createConnection(socket: any, remote: string): TcpConnection {
    let buffer = Buffer.alloc(0);
    const maxFrameSize = this.config.maxFrameSize ?? 16 * 1024 * 1024;

    const conn: TcpConnection = {
      remoteAddress: socket.remoteAddress ?? 'unknown',
      remotePort: socket.remotePort ?? 0,
      
      write: async (data: Uint8Array) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length, 0);
        socket.write(Buffer.concat([length, Buffer.from(data)]));
        this.metrics.bytesSent += data.length + 4;
        this.metrics.messagesSent++;
      },
      
      read: async () => {
        return new Promise<Uint8Array | null>((resolve) => {
          const onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            
            while (buffer.length >= 4) {
              const frameLength = buffer.readUInt32BE(0);
              
              if (frameLength > maxFrameSize) {
                socket.destroy();
                resolve(null);
                return;
              }
              
              if (buffer.length >= 4 + frameLength) {
                const frame = buffer.slice(4, 4 + frameLength);
                buffer = buffer.slice(4 + frameLength);
                
                this.metrics.bytesReceived += frame.length + 4;
                this.metrics.messagesReceived++;
                
                resolve(new Uint8Array(frame));
                return;
              }
              
              break;
            }
          };
          
          socket.on('data', onData);
          socket.once('close', () => {
            socket.off('data', onData);
            resolve(null);
          });
        });
      },
      
      close: async () => {
        socket.destroy();
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