import { TransportHealth, PublishOptions, SubscribeOptions, MessageContext } from '@/core/capabilities.js';
import { Logger } from '@/observability/logger.js';

export type KafkaDriver = 'oneunit' | 'kafkajs' | 'auto';

export interface KafkaAdapterConfig {
  driver?: KafkaDriver;
  brokers: string[];
  clientId: string;
  topics: {
    prefix: string;
  };
  producer?: Record<string, unknown>;
  consumer?: Record<string, unknown>;
  security?: {
    ssl?: boolean | Record<string, unknown>;
    sasl?: {
      mechanism: string;
      username: string;
      password: string;
    };
    ca?: string;
    cert?: string;
    key?: string;
    rejectUnauthorized?: boolean;
  };
}

export interface KafkaDriverAdapter {
  readonly name: string;
  readonly capabilities: {
    requestResponse: boolean;
    streaming: boolean;
    publishSubscribe: boolean;
    durableDelivery: boolean;
    orderedDelivery: boolean;
    bidirectional: boolean;
  };
  start(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<TransportHealth>;
  publish(topic: string, message: unknown, options?: PublishOptions): Promise<void>;
  subscribe(topic: string, handler: (message: unknown, context: MessageContext) => Promise<void>, options?: SubscribeOptions): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}

export interface KafkaDriverModule {
  createAdapter(config: KafkaAdapterConfig, logger?: Logger): Promise<KafkaDriverAdapter>;
}