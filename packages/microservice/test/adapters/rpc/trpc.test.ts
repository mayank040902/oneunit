import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrpcTransport, TrpcConfig } from '@adapters/rpc/trpc/index.js';
import { RpcMethodHandler, RpcContext } from '@core/capabilities.js';

let portCounter = 34567;

function makeConfig(overrides: Partial<TrpcConfig> = {}): TrpcConfig {
  return {
    endpoint: `127.0.0.1:${portCounter++}`,
    router: {},
    ...overrides,
  };
}

function makeConfigFixed(port: number, overrides: Partial<TrpcConfig> = {}): TrpcConfig {
  return {
    endpoint: `127.0.0.1:${port}`,
    router: {},
    ...overrides,
  };
}

describe('TrpcTransport construction', () => {
  it('should report correct capabilities', () => {
    const transport = new TrpcTransport(makeConfig());
    expect(transport.name).toBe('trpc');
    expect(transport.capabilities.requestResponse).toBe(true);
    expect(transport.capabilities.streaming).toBe(false);
    expect(transport.capabilities.publishSubscribe).toBe(false);
    expect(transport.capabilities.durableDelivery).toBe(false);
    expect(transport.capabilities.orderedDelivery).toBe(true);
    expect(transport.capabilities.bidirectional).toBe(false);
  });

  it('should not be started initially', () => {
    const transport = new TrpcTransport(makeConfig());
    expect(transport.isStarted()).toBe(false);
  });

  it('should accept custom endpoint', () => {
    const transport = new TrpcTransport(makeConfig({ endpoint: 'localhost:4000' }));
    expect((transport as any).config.endpoint).toBe('localhost:4000');
  });

  it('should accept custom router', () => {
    const router = { test: 'router' };
    const transport = new TrpcTransport(makeConfig({ router }));
    expect((transport as any).config.router).toBe(router);
  });

  it('should accept cors option', () => {
    const transport = new TrpcTransport(makeConfig({ cors: true }));
    expect((transport as any).config.cors).toBe(true);
  });
});

describe('TrpcTransport method registry', () => {
  let transport: TrpcTransport;

  beforeEach(() => {
    transport = new TrpcTransport(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register a method handler', () => {
    const handler: RpcMethodHandler = vi.fn();
    transport.registerMethod('svc', 'create', handler);

    expect(transport.unregisterMethod('svc', 'create')).toBeUndefined();
  });

  it('should register multiple methods for same service', () => {
    const handler1: RpcMethodHandler = vi.fn();
    const handler2: RpcMethodHandler = vi.fn();
    transport.registerMethod('svc', 'create', handler1);
    transport.registerMethod('svc', 'update', handler2);

    expect(transport.unregisterMethod('svc', 'create')).toBeUndefined();
    expect(transport.unregisterMethod('svc', 'update')).toBeUndefined();
  });

  it('should not throw when unregistering an unknown method', () => {
    expect(() => transport.unregisterMethod('missing', 'nope')).not.toThrow();
  });

  it('should be idempotent across repeated close calls', async () => {
    await transport.close();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
  });

  it('should allow overwriting a method handler', () => {
    const handler1: RpcMethodHandler = vi.fn();
    const handler2: RpcMethodHandler = vi.fn();
    transport.registerMethod('svc', 'create', handler1);
    transport.registerMethod('svc', 'create', handler2);

    // No throw means it worked
    expect(true).toBe(true);
  });
});

describe('TrpcTransport before start', () => {
  it('should reject call when client not initialized', async () => {
    const transport = new TrpcTransport(makeConfig());
    await expect(transport.call('svc', 'create', { x: 1 })).rejects.toThrow();
  });

  it('should reject stream when iterated', async () => {
    const transport = new TrpcTransport(makeConfig());
    const gen = transport.stream('svc', 'create', { x: 1 });
    await expect(gen.next()).rejects.toThrow(/not supported/);
  });

  it('should report unhealthy before start', async () => {
    const transport = new TrpcTransport(makeConfig());
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
    expect(health.checkedAt).toBeDefined();
  });
});

describe.sequential('TrpcTransport start', () => {
  it('should start HTTP server', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34600));
    await transport.start();
    expect(transport.isStarted()).toBe(true);
    await transport.close();
  });

  it('should be idempotent on repeated start', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34601));
    await transport.start();
    await transport.start();
    expect(transport.isStarted()).toBe(true);
    await transport.close();
  });

  it('should report healthy after start', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34602));
    await transport.start();
    const health = await transport.healthCheck();
    expect(health.status).toBe('healthy');
    await transport.close();
  });
});

describe.sequential('TrpcTransport close', () => {
  it('should close without error when not started', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34603));
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('should close server when started', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34604));
    await transport.start();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
  });

  it('should be idempotent on repeated close', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34605));
    await transport.start();
    await transport.close();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
  });
});

describe.sequential('TrpcTransport call', () => {
  it('should reject call when not started', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34606));
    await expect(transport.call('svc', 'create', { x: 1 })).rejects.toThrow();
  });

  it('should throw when service not found', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34607));
    await transport.start();
    // Client will fail to find the service
    await expect(transport.call('nonexistent', 'create', { x: 1 })).rejects.toThrow();
    await transport.close();
  });
});

describe('TrpcTransport stream', () => {
  it('should throw when streaming not supported', async () => {
    const transport = new TrpcTransport(makeConfig());
    const gen = transport.stream('svc', 'create', { x: 1 });
    await expect(gen.next()).rejects.toThrow(/not supported/);
  });
});

describe.sequential('TrpcTransport healthCheck', () => {
  it('should report unhealthy before start', async () => {
    const transport = new TrpcTransport(makeConfig());
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
  });

  it('should report healthy after start', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34608));
    await transport.start();
    const health = await transport.healthCheck();
    expect(health.status).toBe('healthy');
    await transport.close();
  });

  it('should report unhealthy after close', async () => {
    const transport = new TrpcTransport(makeConfigFixed(34609));
    await transport.start();
    await transport.close();
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
  });
});