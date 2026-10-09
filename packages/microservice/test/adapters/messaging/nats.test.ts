import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NatsTransport } from '../../../src/adapters/messaging/nats/index.js';
import { NatsAdapterConfig } from '../../../src/config/schema.js';

function makeConfig(overrides: Partial<NatsAdapterConfig> = {}): NatsAdapterConfig {
  return {
    enabled: true,
    servers: ['nats://localhost:4222'],
    clientName: 'test-client',
    subjects: { prefix: 'oneunit' },
    jetstream: { enabled: false },
    auth: {},
    tls: false,
    ...overrides,
  };
}

describe('NatsTransport construction', () => {
  it('should report correct capabilities for Core mode', () => {
    const transport = new NatsTransport(makeConfig());
    expect(transport.name).toBe('nats');
    expect(transport.capabilities.requestResponse).toBe(true);
    expect(transport.capabilities.streaming).toBe(false);
    expect(transport.capabilities.publishSubscribe).toBe(true);
    expect(transport.capabilities.durableDelivery).toBe(false);
    expect(transport.capabilities.orderedDelivery).toBe(true);
    expect(transport.capabilities.bidirectional).toBe(true);
  });

  it('should report durableDelivery when JetStream is enabled', () => {
    const transport = new NatsTransport(makeConfig({ jetstream: { enabled: true } }));
    expect(transport.capabilities.durableDelivery).toBe(true);
  });

  it('should not be started initially', () => {
    const transport = new NatsTransport(makeConfig());
    expect(transport.isStarted()).toBe(false);
  });

  it('should default subject prefix', () => {
    const transport = new NatsTransport(makeConfig({ subjects: { prefix: 'svc' } }));
    expect((transport as any).config.subjects.prefix).toBe('svc');
  });
});

describe('NatsTransport before start', () => {
  it('should reject subscribe when not connected', async () => {
    const transport = new NatsTransport(makeConfig());
    await expect(transport.subscribe('topic', async () => {})).rejects.toThrow(/NATS not connected/);
  });

  it('should be a no-op unsubscribe before start', async () => {
    const transport = new NatsTransport(makeConfig());
    await expect(transport.unsubscribe('topic')).resolves.toBeUndefined();
  });

  it('should report unhealthy before start', async () => {
    const transport = new NatsTransport(makeConfig());
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
    expect(health.details).toEqual({ connected: false, jetstream: false });
  });

  it('should report unhealthy when only JetStream is configured but not connected', async () => {
    const transport = new NatsTransport(makeConfig({ jetstream: { enabled: true } }));
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
    expect(health.details).toEqual({ connected: false, jetstream: false });
  });
});

describe('NatsTransport close', () => {
  it('should be idempotent across repeated close calls', async () => {
    const transport = new NatsTransport(makeConfig());
    await transport.close();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
  });
});

describe('NatsTransport subject construction', () => {
  it('should build a prefixed subject for publish', async () => {
    const transport = new NatsTransport(makeConfig({ subjects: { prefix: 'oneunit' } }));
    // Inject a fake connection so publish() can be exercised without a broker.
    const publishMock = vi.fn();
    (transport as any).nc = { publish: publishMock };

    await transport.publish('orders.created', { id: 1 });

    expect(publishMock).toHaveBeenCalledWith(
      'oneunit.orders.created',
      expect.any(Uint8Array),
    );
  });

  it('should serialize the message as JSON bytes', async () => {
    const transport = new NatsTransport(makeConfig({ subjects: { prefix: 'oneunit' } }));
    const publishMock = vi.fn();
    (transport as any).nc = { publish: publishMock };

    await transport.publish('orders.created', { id: 1, name: 'x' });

    const payload = publishMock.mock.calls[0][1];
    const decoded = JSON.parse(new TextDecoder().decode(payload));
    expect(decoded).toEqual({ id: 1, name: 'x' });
  });

  it('should publish to JetStream when enabled and a JS client is available', async () => {
    const transport = new NatsTransport(makeConfig({ jetstream: { enabled: true } }));
    const jsPublishMock = vi.fn().mockResolvedValue(undefined);
    (transport as any).js = { publish: jsPublishMock };
    (transport as any).nc = { publish: vi.fn() };

    await transport.publish('orders.created', { id: 1 });

    expect(jsPublishMock).toHaveBeenCalledWith(
      'oneunit.orders.created',
      expect.any(Uint8Array),
      { headers: undefined },
    );
  });
});

describe('NatsTransport unsubscribe', () => {
  it('should remove the subscription from the registry', async () => {
    const transport = new NatsTransport(makeConfig());
    const unsubscribeMock = vi.fn().mockResolvedValue(undefined);
    (transport as any).subscriptions.set('topic', { unsubscribe: unsubscribeMock });

    await transport.unsubscribe('topic');

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect((transport as any).subscriptions.has('topic')).toBe(false);
  });

  it('should be a no-op for an unknown topic', async () => {
    const transport = new NatsTransport(makeConfig());
    await expect(transport.unsubscribe('unknown')).resolves.toBeUndefined();
  });
});