import { BaseTransport, TransportConfig } from '@/transport/transport';
import { TransportCapabilities, TransportHealth, MessagePublisher, MessageSubscriber, PublishOptions, SubscribeOptions } from '@/core/capabilities';
import { KafkaAdapterConfig, KafkaDriver, KafkaDriverAdapter } from './types.js';
import { resolveKafkaDriver } from './driver-resolver.js';

export class KafkaTransport extends BaseTransport implements MessagePublisher, MessageSubscriber {
  private config: KafkaAdapterConfig;
  private driverAdapter: KafkaDriverAdapter | null = null;
  private resolvedDriver: KafkaDriver = 'kafkajs';

  constructor(config: KafkaAdapterConfig) {
    super({
      name: 'kafka',
      capabilities: {
        requestResponse: false,
        streaming: false,
        publishSubscribe: true,
        durableDelivery: true,
        orderedDelivery: true,
        bidirectional: false,
      },
    });
    this.config = config;
  }

  async start(): Promise<void> {
    const resolved = await resolveKafkaDriver(this.config);
    this.resolvedDriver = resolved.driver;
    this.driverAdapter = await resolved.module.createAdapter(this.config);
    await this.driverAdapter.start();
  }

  async close(): Promise<void> {
    if (this.driverAdapter) {
      await this.driverAdapter.close();
      this.driverAdapter = null;
    }
  }

  async healthCheck(): Promise<TransportHealth> {
    if (!this.driverAdapter) {
      return {
        status: 'unhealthy',
        checkedAt: Date.now(),
        details: { connected: false, driver: this.resolvedDriver },
      };
    }
    return this.driverAdapter.healthCheck();
  }

  async publish(topic: string, message: unknown, options: PublishOptions = {}): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Kafka transport not started');
    }
    return this.driverAdapter.publish(topic, message, options);
  }

  async subscribe(
    topic: string, 
    handler: (message: unknown, context: any) => Promise<void>, 
    options: SubscribeOptions = {}
  ): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Kafka transport not started');
    }
    return this.driverAdapter.subscribe(topic, handler, options);
  }

  async unsubscribe(topic: string): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Kafka transport not started');
    }
    return this.driverAdapter.unsubscribe(topic);
  }

  getResolvedDriver(): KafkaDriver {
    return this.resolvedDriver;
  }
}

export function createKafkaTransport(config: KafkaAdapterConfig): KafkaTransport {
  return new KafkaTransport(config);
}