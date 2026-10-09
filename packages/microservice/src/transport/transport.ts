import { TransportCapabilities, TransportHealth, Transport, TransportMetrics } from '../core/capabilities.js';

export interface TransportConfig {
  name: string;
  capabilities: TransportCapabilities;
}

export abstract class BaseTransport implements Transport {
  readonly name: string;
  readonly capabilities: TransportCapabilities;
  started = false;

  constructor(config: TransportConfig) {
    this.name = config.name;
    this.capabilities = config.capabilities;
  }

  abstract start(): Promise<void>;
  abstract close(): Promise<void>;

  abstract healthCheck(): Promise<TransportHealth>;

  isStarted(): boolean {
    return this.started;
  }
}