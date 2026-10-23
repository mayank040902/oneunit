import { describe, it, expect, afterEach } from 'vitest';
import {
  createMessagingAdapter,
  getMessagingAdapterFactory,
  setMessagingAdapterFactory,
  type MessagingAdapter,
  type MessagingAdapterConfig,
} from '../../../src/adapters/messaging/index.js';
import { MessagingProviderRegistry } from '../../../src/adapters/messaging/provider-registry.js';
import { KafkaTransport } from '../../../src/adapters/messaging/kafka/adapter.js';
import { NatsTransport } from '../../../src/adapters/messaging/nats/index.js';

function createStubAdapter(name: string): MessagingAdapter {
  let started = false;
  return {
    name,
    capabilities: {
      requestResponse: false,
      streaming: false,
      publishSubscribe: true,
      durableDelivery: false,
      orderedDelivery: false,
      bidirectional: false,
    },
    async start() {
      started = true;
    },
    async close() {
      started = false;
    },
    async healthCheck() {
      return { status: 'healthy' as const, checkedAt: Date.now() };
    },
    async publish() {},
    async subscribe() {},
    async unsubscribe() {},
    isStarted() {
      return started;
    },
  } as unknown as MessagingAdapter;
}

describe('DefaultMessagingAdapterFactory', () => {
  it('should create a Kafka adapter when the provider is kafka', async () => {
    const adapter = await createMessagingAdapter({ provider: 'kafka', brokers: ['localhost:9092'] });

    expect(adapter).toBeInstanceOf(KafkaTransport);
  });

  it('should create a NATS adapter when the provider is nats', async () => {
    const adapter = await createMessagingAdapter({ provider: 'nats', servers: ['nats://localhost:4222'] });

    expect(adapter).toBeInstanceOf(NatsTransport);
  });

  it('should reject an unsupported provider', async () => {
    await expect(createMessagingAdapter({ provider: 'unknown' })).rejects.toThrow(
      /Unsupported messaging provider/,
    );
  });
});

describe('MessagingProviderRegistry', () => {
  it('should create an adapter from a registered provider', async () => {
    const registry = new MessagingProviderRegistry();
    const stub = createStubAdapter('custom');
    registry.register('custom', { create: async () => stub });

    const adapter = await registry.create({ provider: 'custom' });

    expect(adapter).toBe(stub);
  });

  it('should reject a provider that is not registered', async () => {
    const registry = new MessagingProviderRegistry();

    await expect(registry.create({ provider: 'missing' })).rejects.toThrow(
      /Provider 'missing' not registered/,
    );
  });

  it('should list the registered providers', () => {
    const registry = new MessagingProviderRegistry();
    registry.register('p1', { create: async () => createStubAdapter('p1') });
    registry.register('p2', { create: async () => createStubAdapter('p2') });

    expect(registry.list()).toEqual(['p1', 'p2']);
    expect(registry.has('p1')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
  });

  it('should remove a provider when it is unregistered', () => {
    const registry = new MessagingProviderRegistry();
    registry.register('p1', { create: async () => createStubAdapter('p1') });

    const removed = registry.unregister('p1');

    expect(removed).toBe(true);
    expect(registry.has('p1')).toBe(false);
    expect(registry.unregister('p1')).toBe(false);
  });

  it('should pass the provider config to the provider constructor', async () => {
    const registry = new MessagingProviderRegistry();
    const received: Record<string, unknown>[] = [];
    registry.register('custom', {
      create: async (config) => {
        received.push(config);
        return createStubAdapter('custom');
      },
    });

    await registry.create({ provider: 'custom', topic: 'orders' });

    expect(received).toEqual([{ topic: 'orders' }]);
  });
});

describe('messaging adapter factory registry', () => {
  const originalFactory = getMessagingAdapterFactory();

  afterEach(() => {
    setMessagingAdapterFactory(originalFactory);
  });

  it('should use the factory that was set', () => {
    const registry = new MessagingProviderRegistry();

    setMessagingAdapterFactory(registry);

    expect(getMessagingAdapterFactory()).toBe(registry);
  });

  it('should route adapter creation through the installed factory', async () => {
    const registry = new MessagingProviderRegistry();
    const stub = createStubAdapter('installed');
    registry.register('installed', { create: async () => stub });
    setMessagingAdapterFactory(registry);

    const config: MessagingAdapterConfig = { provider: 'installed' };
    const adapter = await createMessagingAdapter(config);

    expect(adapter).toBe(stub);
  });
});
