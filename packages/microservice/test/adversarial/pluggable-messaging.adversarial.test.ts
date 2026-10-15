import { describe, it, expect } from 'vitest';
import {
  createMessagingAdapter,
  MessagingProviderRegistry,
  setMessagingAdapterFactory,
  getMessagingAdapterFactory,
} from '../../src/adapters/messaging/index.js';
import { KafkaTransport } from '../../src/adapters/messaging/kafka/adapter.js';
import { NatsTransport } from '../../src/adapters/messaging/nats/index.js';

describe('Pluggable Messaging - Adversarial/Extension Tests', () => {
  it('should create Kafka adapter via factory', async () => {
    const adapter = await createMessagingAdapter({ provider: 'kafka', brokers: ['localhost:9092'] } as any);
    expect(adapter).toBeInstanceOf(KafkaTransport);
  });

  it('should create NATS adapter via factory', async () => {
    const adapter = await createMessagingAdapter({ provider: 'nats', servers: ['nats://localhost:4222'] } as any);
    expect(adapter).toBeInstanceOf(NatsTransport);
  });

  it('should throw for unsupported provider', async () => {
    await expect(
      createMessagingAdapter({ provider: 'unknown', url: 'amqp://localhost' } as any)
    ).rejects.toThrow(/Unsupported messaging provider|not registered/);
  });

  it('should support custom provider registration', async () => {
    const registry = new MessagingProviderRegistry();
    const mockAdapter = {
      name: 'custom',
      capabilities: {
        requestResponse: true,
        streaming: false,
        publishSubscribe: true,
        durableDelivery: false,
        orderedDelivery: false,
        bidirectional: false,
      },
      async start() {},
      async close() {},
      async healthCheck() { return { status: 'healthy' as const, checkedAt: Date.now() }; },
      async publish() {},
      async subscribe() {},
      async unsubscribe() {},
      isStarted() { return true; },
    } as any;
    
    registry.register('custom', {
      create: async () => mockAdapter,
    });
    
    const adapter = await registry.create({ provider: 'custom' });
    expect(adapter).toBe(mockAdapter);
  });

  it('should list registered providers', () => {
    const registry = new MessagingProviderRegistry();
    registry.register('p1', { create: async () => ({} as any) });
    registry.register('p2', { create: async () => ({} as any) });
    expect(registry.list()).toContain('p1');
    expect(registry.list()).toContain('p2');
    expect(registry.has('p1')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
  });

  it('should allow factory replacement', () => {
    const original = getMessagingAdapterFactory();
    const registry = new MessagingProviderRegistry();
    setMessagingAdapterFactory(registry);
    expect(getMessagingAdapterFactory()).toBe(registry);
    setMessagingAdapterFactory(original);
  });
});
