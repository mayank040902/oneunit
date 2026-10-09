import { Transport, TransportCapabilities, TransportHealth, TransportMetrics } from '../core/capabilities.js';
import { BaseTransport } from './transport.js';

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

  async send(protocol: string, to: string, message: any): Promise<void> {
    const transport = this.getByCapability('requestResponse').find(t => t.name === protocol);
    if (!transport) {
      throw new Error(`No transport found for protocol: ${protocol}`);
    }
    // This would need to be implemented by the specific transport
    throw new Error('send not implemented on base transport');
  }

  async broadcast(protocol: string, message: any, exclude?: string[]): Promise<void> {
    const transports = this.getByCapability('publishSubscribe');
    for (const transport of transports) {
      if (exclude && exclude.includes(transport.name)) continue;
      // This would need to be implemented by the specific transport
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