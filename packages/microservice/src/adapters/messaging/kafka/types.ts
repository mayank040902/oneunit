import { TransportCapabilities, TransportHealth, MessagePublisher, MessageSubscriber, PublishOptions, SubscribeOptions } from '@/core/capabilities';
import { Logger } from '@/observability/logger';

export type KafkaDriver = 'oneunit' | 'kafkajs' | 'auto';

export interface KafkaAdapterConfig {
  driver?: KafkaDriver;
  brokers: string[];
  clientId: string;
  topics: {
    prefix: string;
  };
  producer?: any;
  consumer?: any;
  security?: {
    ssl?: boolean;
    sasl?: {
      mechanism: string;
      username: string;
      password: string;
    };
  };
}

export interface KafkaDriverAdapter {
  readonly name: string;
  readonly capabilities: TransportCapabilities;
  start(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<TransportHealth>;
  publish(topic: string, message: unknown, options?: PublishOptions): Promise<void>;
  subscribe(topic: string, handler: (message: unknown, context: any) => Promise<void>, options?: SubscribeOptions): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}

export interface KafkaDriverModule {
  createAdapter(config: KafkaAdapterConfig, logger?: Logger): Promise<KafkaDriverAdapter>;
}