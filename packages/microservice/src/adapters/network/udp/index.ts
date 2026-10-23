import { BaseTransport } from '@/transport/transport';
import { TransportHealth, DatagramTransport } from '@/core/capabilities';
import { resolveSecurity, createSecuredDispatcher } from '@/core/secured-dispatcher.js';
import type { ResolvedSecurity } from '@/core/secured-dispatcher.js';
import type { SecuredRequestContext } from '@/core/secured-dispatcher.js';
import type { ServiceCredentials } from '@/identity/credentials.js';
import type * as dgram from 'dgram';

export interface UdpConfig {
  host: string;
  port: number;
  maxPacketSize?: number;
  ttl?: number;
  multicast?: {
    address: string;
    interface?: string;
  };
  bindingTimeout?: number;
  logger?: { error: (...args: unknown[]) => void };
}

export interface UdpPacket {
  data: Uint8Array;
  source: { address: string; port: number };
}

export class UdpTransport extends BaseTransport implements DatagramTransport {
  private config: UdpConfig;
  private securityInput: unknown;
  private socket: dgram.Socket | null = null;
  private messageHandler: ((data: Uint8Array, source: { address: string; port: number }) => void) | null = null;
  private securedDispatcherInstance: ReturnType<typeof createSecuredDispatcher> | null = null;

  constructor(config: UdpConfig, security?: unknown) {
    super({
      name: 'udp',
      capabilities: {
        requestResponse: false,
        streaming: false,
        publishSubscribe: true,
        durableDelivery: false,
        orderedDelivery: false,
        bidirectional: true,
      },
    });
    this.config = config;
    this.securityInput = security;
  }

  private getSecuredDispatcher() {
    if (this.securedDispatcherInstance) return this.securedDispatcherInstance;
    const resolved = resolveSecurity(this.config, this.securityInput, this) as ResolvedSecurity;
    if (!resolved.protected) return null;
    const dispatcher = resolved.dispatcher ?? (resolved.options ? createSecuredDispatcher(resolved.options) : null);
    this.securedDispatcherInstance = dispatcher;
    return dispatcher;
  }

  private isSecurityRequired(): boolean {
    const si = this.securityInput as Record<string, unknown> | undefined;
    const cfg = this.config as unknown as Record<string, unknown>;
    return !!(si?.['securityRequired'] === true || si?.['requireSecurity'] === true || cfg['securityRequired'] === true || cfg['requireSecurity'] === true);
  }

  private parseCredentials(data: Uint8Array): ServiceCredentials | undefined {
    try {
      const parsed = JSON.parse(Buffer.from(data).toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      const record = parsed as Record<string, unknown>;
      const candidate = record['credentials'] ?? record['creds'] ?? record['credential'] ?? record['auth'] ?? record['authentication'] ?? record['token'];
      if (!candidate) return undefined;
      if (typeof candidate === 'string') {
        try {
          return JSON.parse(candidate) as ServiceCredentials;
        } catch {
          return undefined;
        }
      }
      if (typeof candidate === 'object') return candidate as ServiceCredentials;
    } catch {
      return undefined;
    }
    return undefined;
  }
  async start(): Promise<void> {
    const { createSocket } = await import('dgram');
    
    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    
    this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.handleDatagram(new Uint8Array(msg), { address: rinfo.address, port: rinfo.port });
    });

    this.socket.on('error', (err: Error) => {
      (this.config.logger ?? console).error('UDP socket error:', err);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        reject(err);
      };
      this.socket!.once('error', onError);
      const timer = this.config.bindingTimeout
        ? setTimeout(() => {
            this.socket?.removeListener('error', onError);
            reject(new Error(`UDP bind timed out after ${this.config.bindingTimeout}ms`));
          }, this.config.bindingTimeout)
        : null;
      if (timer) timer.unref();
      this.socket!.bind(this.config.port, this.config.host, () => {
        if (timer) clearTimeout(timer);
        this.socket!.removeListener('error', onError);
        resolve();
      });
    });

    if (this.config.multicast) {
      this.socket.addMembership(this.config.multicast.address, this.config.multicast.interface);
      this.socket.setMulticastTTL(this.config.ttl ?? 1);
      this.socket.setMulticastLoopback(true);
    }

    this.started = true;
  }

  async close(): Promise<void> {
    if (this.config.multicast) {
      this.socket?.dropMembership(this.config.multicast.address);
    }

    if (this.socket) {
      await new Promise<void>((resolve) => {
        this.socket!.close(resolve);
      });
    }

    this.started = false;
  }

  async healthCheck(): Promise<TransportHealth> {
    return {
      status: this.isStarted() ? 'healthy' : 'unhealthy',
      checkedAt: Date.now(),
    };
  }

  private handleDatagram(data: Uint8Array, source: { address: string; port: number }): void {
    const handler = this.messageHandler;
    if (!handler) return;

    const maxPacketSize = this.config.maxPacketSize ?? 65507;
    if (data.length > maxPacketSize) return;

    const dispatcher = this.getSecuredDispatcher();
    if (!dispatcher) {
      if (this.isSecurityRequired()) return;
      handler(data, source);
      return;
    }

    const credentials = this.parseCredentials(data);
    const metadata = new Map<string, unknown>();
    if (credentials !== undefined) {
      metadata.set('credentials', credentials);
    }

    const request: SecuredRequestContext = {
      service: 'udp',
      method: 'datagram',
      transport: 'udp',
      operation: 'udp.datagram',
      targetService: 'udp',
      credentials,
      metadata,
      attributes: { sourceAddress: source.address, sourcePort: source.port },
      correlationId: crypto.randomUUID(),
    };

    void dispatcher.dispatch(request, async () => {
      handler(data, source);
      return undefined;
    }).catch(() => {
      // Dispatcher failures are tracked by dispatcher instrumentation and must not invoke the handler.
    });
  }

  send(data: Uint8Array, target: string, port: number): Promise<void> {
    if (!this.socket) {
      return Promise.reject(new Error('UDP socket not initialized'));
    }

    const maxSize = this.config.maxPacketSize ?? 65507;
    if (data.length > maxSize) {
      return Promise.reject(new Error(`Packet size ${data.length} exceeds maximum ${maxSize}`));
    }

    return new Promise((resolve, reject) => {
      this.socket!.send(data, port, target, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  onMessage(handler: (data: Uint8Array, source: { address: string; port: number }) => void): void {
    this.messageHandler = handler;
  }
}

export function createUdpTransport(config: UdpConfig): UdpTransport {
  return new UdpTransport(config);
}