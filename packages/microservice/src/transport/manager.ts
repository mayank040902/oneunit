import { Transport, TransportCapabilities, TransportHealth, TransportMetrics, MessagePublisher, PointToPointTransport } from '../core/capabilities.js';

export interface TransportManagerConfig {
  healthCheckIntervalMs?: number;
}

export class TransportManager {
  private transports: Map<string, Transport> = new Map();
  private config: TransportManagerConfig;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private metrics: Map<string, TransportMetrics> = new Map();

  constructor(config: TransportManagerConfig = {}) {
    this.config = config;
  }

  register(transport: Transport): void {
    if (this.transports.has(transport.name)) {
      throw new Error(`Transport ${transport.name} already registered`);
    }
    this.transports.set(transport.name, transport);
    this.metrics.set(transport.name, this.createEmptyMetrics());
  }

  unregister(name: string): boolean {
    this.metrics.delete(name);
    return this.transports.delete(name);
  }

  get(name: string): Transport | undefined {
    return this.transports.get(name);
  }

  getAll(): Transport[] {
    return Array.from(this.transports.values());
  }

  getByCapability(capability: keyof TransportCapabilities): Transport[] {
    return Array.from(this.transports.values()).filter(t => t.capabilities[capability]);
  }

  async startAll(): Promise<void> {
    const errors: Error[] = [];
    
    for (const transport of this.transports.values()) {
      try {
        await transport.start();
      } catch (err) {
        errors.push(err as Error);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to start transports: ${errors.map(e => e.message).join(', ')}`);
    }

    if (this.config.healthCheckIntervalMs) {
      this.startHealthChecks();
    }
  }

  async stopAll(): Promise<void> {
    this.stopHealthChecks();
    
    const errors: Error[] = [];
    for (const transport of this.transports.values()) {
      try {
        await transport.close();
      } catch (err) {
        errors.push(err as Error);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to stop transports: ${errors.map(e => e.message).join(', ')}`);
    }
  }

  async healthCheckAll(): Promise<Record<string, TransportHealth>> {
    const results: Record<string, TransportHealth> = {};
    
    for (const [name, transport] of this.transports) {
      try {
        results[name] = await transport.healthCheck();
      } catch (err) {
        results[name] = {
          status: 'unhealthy',
          checkedAt: Date.now(),
          details: { error: (err as Error).message },
        };
      }
    }
    
    return results;
  }

  // Route a point-to-point message to the transport
  // registered under the protocol name. The transport
  // must implement PointToPointTransport; transports
  // without direct addressing fail with a clear error
  // instead of an unconditional throw.
  async send(protocol: string, to: string, message: unknown): Promise<void> {
    const transport = this.transports.get(protocol);
    if (!transport) {
      throw new Error(`No transport found for protocol: ${protocol}`);
    }

    const sender = transport as unknown as PointToPointTransport;
    if (typeof sender.send !== 'function') {
      throw new Error(
        `Transport ${protocol} does not implement point-to-point send`,
      );
    }

    await sender.send(to, message);
  }

  // Broadcast a message on the channel named by
  // `protocol` through every registered transport
  // that implements MessagePublisher, skipping the
  // excluded transports. Transports without a
  // publish operation are not broadcast targets.
  async broadcast(protocol: string, message: unknown, exclude?: string[]): Promise<void> {
    for (const transport of this.transports.values()) {
      if (exclude && exclude.includes(transport.name)) continue;

      const publisher = transport as unknown as MessagePublisher;
      if (typeof publisher.publish !== 'function') continue;

      await publisher.publish(protocol, message);
    }
  }

  async isHealthy(): Promise<boolean> {
    for (const transport of this.transports.values()) {
      try {
        const health = await transport.healthCheck();
        if (health.status === 'unhealthy') return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  recordMetrics(transportName: string, metric: Partial<TransportMetrics>): void {
    const current = this.metrics.get(transportName);
    if (current) {
      Object.assign(current, metric);
    }
  }

  getMetrics(transportName: string): TransportMetrics | undefined {
    return this.metrics.get(transportName);
  }

  getAllMetrics(): Record<string, TransportMetrics> {
    const result: Record<string, TransportMetrics> = {};
    for (const [name, metrics] of this.metrics) {
      result[name] = metrics;
    }
    return result;
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

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      await this.healthCheckAll();
    }, this.config.healthCheckIntervalMs);
  }

  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

export function createTransportManager(config?: TransportManagerConfig): TransportManager {
  return new TransportManager(config);
}