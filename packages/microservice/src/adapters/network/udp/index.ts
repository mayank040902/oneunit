import { BaseTransport, TransportConfig } from '@/transport/transport';
import { TransportCapabilities, TransportHealth, DatagramTransport } from '@/core/capabilities';

export interface UdpConfig {
  host: string;
  port: number;
  maxPacketSize?: number;
  ttl?: number;
  multicast?: {
    address: string;
    interface?: string;
  };
}

export interface UdpPacket {
  data: Uint8Array;
  source: { address: string; port: number };
}

export class UdpTransport extends BaseTransport implements DatagramTransport {
  private config: UdpConfig;
  private socket: any;
  private messageHandler: ((data: Uint8Array, source: { address: string; port: number }) => void) | null = null;

  constructor(config: UdpConfig) {
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
  }

  async start(): Promise<void> {
    const { createSocket } = await import('dgram');
    
    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    
    this.socket.on('message', (msg: Buffer, rinfo: any) => {
      if (this.messageHandler) {
        this.messageHandler(new Uint8Array(msg), { address: rinfo.address, port: rinfo.port });
      }
    });

    this.socket.on('error', (err: Error) => {
      console.error('UDP socket error:', err);
    });

    await new Promise<void>((resolve, reject) => {
      this.socket.bind(this.config.port, this.config.host, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (this.config.multicast) {
      this.socket.addMembership(this.config.multicast.address, this.config.multicast.interface);
      this.socket.setMulticastTTL(this.config.ttl ?? 1);
      this.socket.setMulticastLoopback(true);
    }
  }

  async close(): Promise<void> {
    if (this.config.multicast) {
      this.socket.dropMembership(this.config.multicast.address);
    }
    
    if (this.socket) {
      await new Promise<void>((resolve) => {
        this.socket.close(resolve);
      });
    }
  }

  async healthCheck(): Promise<TransportHealth> {
    return {
      status: this.isStarted() ? 'healthy' : 'unhealthy',
      checkedAt: Date.now(),
    };
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
      this.socket.send(data, port, target, (err: Error | null) => {
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