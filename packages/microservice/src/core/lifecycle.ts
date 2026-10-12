import { EventEmitter } from 'events';
import { Transport, TransportHealth } from './capabilities.js';
import { createMicroserviceError } from './errors.js';

// 'degraded' is a sub-state of 'running': the instance
// is up but at least one registered transport reports
// 'unhealthy'. It re-enters 'running' automatically
// when every transport reports healthy again.
export type LifecycleState = 'initialized' | 'starting' | 'running' | 'degraded' | 'stopping' | 'stopped' | 'failed';

export interface LifecycleHooks {
  onStart?: () => Promise<void>;
  onStop?: () => Promise<void>;
  onHealthCheck?: () => Promise<Record<string, unknown>>;
}

export class LifecycleManager extends EventEmitter {
  private state: LifecycleState = 'initialized';
  private transports: Map<string, Transport> = new Map();
  private hooks: LifecycleHooks = {};
  private startOrder: string[] = [];
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly healthCheckIntervalMs: number;

  constructor(healthCheckIntervalMs = 30000) {
    super();
    this.healthCheckIntervalMs = healthCheckIntervalMs;
  }

  setHooks(hooks: LifecycleHooks): void {
    this.hooks = hooks;
  }

  registerTransport(transport: Transport): void {
    if (this.transports.has(transport.name)) {
      throw createMicroserviceError(
        'TRANSPORT_ALREADY_REGISTERED',
        `Transport ${transport.name} is already registered`,
        'CONFIGURATION'
      );
    }
    this.transports.set(transport.name, transport);
  }

  unregisterTransport(name: string): boolean {
    return this.transports.delete(name);
  }

  getTransport(name: string): Transport | undefined {
    return this.transports.get(name);
  }

  getAllTransports(): Transport[] {
    return Array.from(this.transports.values());
  }

  getState(): LifecycleState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== 'initialized' && this.state !== 'stopped') {
      throw createMicroserviceError(
        'INVALID_STATE',
        `Cannot start from state: ${this.state}`,
        'CONFIGURATION'
      );
    }
    this.state = 'starting';
    this.emit('stateChange', this.state);

    try {
      if (this.hooks.onStart) {
        await this.hooks.onStart();
      }

      // Startup order is registration order.
      // Transport dependencies are not a
      // supported public concept, so no
      // dependency sorting is performed.
      const transportNames = Array.from(this.transports.keys());
      this.startOrder = transportNames;

      for (const name of this.startOrder) {
        const transport = this.transports.get(name)!;
        try {
          await transport.start();
          this.emit('transportStarted', name);
        } catch (err) {
          this.emit('transportStartError', name, err);
          throw createMicroserviceError(
            'TRANSPORT_START_FAILED',
            `Failed to start transport: ${name}`,
            'TRANSPORT',
            false,
            { details: { transport: name, originalError: err instanceof Error ? err.message : String(err) } }
          );
        }
      }

      this.startHealthChecks();
      this.state = 'running';
      this.emit('stateChange', this.state);
      this.emit('started');
    } catch (err) {
      this.state = 'failed';
      this.emit('stateChange', this.state);
      throw err;
    }
  }

  async stop(): Promise<void> {
    // 'degraded' is a running sub-state: shutdown
    // proceeds exactly as from 'running'.
    if (this.state === 'stopping' || this.state === 'stopped') {
      return;
    }

    this.state = 'stopping';
    this.emit('stateChange', this.state);

    this.stopHealthChecks();

    const stopOrder = [...this.startOrder].reverse();
    const errors: Error[] = [];

    for (const name of stopOrder) {
      const transport = this.transports.get(name);
      if (transport) {
        try {
          await transport.close();
          this.emit('transportStopped', name);
        } catch (err) {
          this.emit('transportStopError', name, err);
          errors.push(err as Error);
        }
      }
    }

    if (this.hooks.onStop) {
      try {
        await this.hooks.onStop();
      } catch (err) {
        errors.push(err as Error);
      }
    }

    this.state = 'stopped';
    this.emit('stateChange', this.state);
    this.emit('stopped');

    if (errors.length > 0) {
      throw createMicroserviceError(
        'STOP_ERRORS',
        `Errors during shutdown: ${errors.map(e => e.message).join(', ')}`,
        'INTERNAL',
        false,
        { details: { errors: errors.map(e => e.message) } }
      );
    }
  }

  async healthCheck(): Promise<Record<string, TransportHealth>> {
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

    if (this.hooks.onHealthCheck) {
      try {
        const custom = await this.hooks.onHealthCheck();
        results['application'] = {
          status: 'healthy',
          checkedAt: Date.now(),
          details: custom,
        };
      } catch {
        results['application'] = {
          status: 'unhealthy',
          checkedAt: Date.now(),
        };
      }
    }

    return results;
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.healthCheck();
        this.emit('healthCheck', health);
        
      const unhealthy = Object.entries(health).filter(
        ([, h]) => h.status === 'unhealthy'
      );
      
      if (unhealthy.length > 0) {
        this.emit('degraded', unhealthy.map(([name]) => name));
        if (this.state === 'running') {
          this.state = 'degraded';
          this.emit('stateChange', this.state);
        }
      } else if (this.state === 'degraded') {
        // Every transport recovered: leave the
        // degraded sub-state back into 'running'.
        this.state = 'running';
        this.emit('stateChange', this.state);
      }
    } catch (err) {
      this.emit('healthCheckError', err);
    }
  }, this.healthCheckIntervalMs);
  }

  private stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}

export function createLifecycleManager(healthCheckIntervalMs?: number): LifecycleManager {
  return new LifecycleManager(healthCheckIntervalMs);
}