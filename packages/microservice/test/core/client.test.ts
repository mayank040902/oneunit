import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MicroserviceClient, createClient, ClientOptions, RetryPolicy } from '../../src/core/client.js';
import { Transport, TransportCapabilities, RpcClient, MessagePublisher, MessageSubscriber } from '../../src/core/capabilities.js';
import { ServiceIdentity } from '../../src/identity/service-identity.js';
import { AuthorizationPolicy } from '../../src/identity/authorization.js';

function makeServiceIdentity(): ServiceIdentity {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'test-service',
    instanceId: '123e4567-e89b-12d3-a456-426614174001',
    credentials: undefined,
    endpoints: [],
    capabilities: [],
    metadata: {},
  };
}

function makeAuthorizationPolicy(): AuthorizationPolicy {
  return {
    type: 'allowlist',
    entries: [],
    defaultPolicy: 'deny',
  };
}

function makeClientOptions(overrides: Partial<ClientOptions> = {}): ClientOptions {
  return {
    service: makeServiceIdentity(),
    authorization: makeAuthorizationPolicy(),
    defaultTimeout: 5000,
    retryPolicy: {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      jitter: true,
      retryableCategories: ['UNAVAILABLE', 'DEADLINE_EXCEEDED'],
    },
    ...overrides,
  };
}

function makeMockTransport(name: string, capabilities: Partial<TransportCapabilities> = {}): Transport {
  const fullCaps: TransportCapabilities = {
    requestResponse: false,
    streaming: false,
    publishSubscribe: false,
    durableDelivery: false,
    orderedDelivery: false,
    bidirectional: false,
    ...capabilities,
  };

  return {
    name,
    capabilities: fullCaps,
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
  };
}

function makeRpcTransport(name = 'rpc'): Transport & RpcClient {
  const transport = makeMockTransport(name, { requestResponse: true, streaming: true });
  return {
    ...transport,
    call: vi.fn().mockResolvedValue({ success: true }),
    stream: vi.fn().mockImplementation(async function* () { yield { success: true }; }),
  };
}

function makeMessagingTransport(name = 'kafka'): Transport & MessagePublisher & MessageSubscriber {
  const transport = makeMockTransport(name, { publishSubscribe: true, durableDelivery: true });
  return {
    ...transport,
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  };
}

describe('MicroserviceClient construction', () => {
  it('should create with required options', () => {
    const client = new MicroserviceClient(makeClientOptions());
    expect(client).toBeInstanceOf(MicroserviceClient);
  });

  it('should create via factory', () => {
    const client = createClient(makeClientOptions());
    expect(client).toBeInstanceOf(MicroserviceClient);
  });

  it('should store options', () => {
    const options = makeClientOptions({ defaultTimeout: 10000 });
    const client = new MicroserviceClient(options);
    expect((client as any).options.defaultTimeout).toBe(10000);
  });

  it('should store retry policy', () => {
    const retryPolicy: RetryPolicy = {
      maxRetries: 5,
      baseDelayMs: 200,
      maxDelayMs: 10000,
      jitter: false,
      retryableCategories: ['UNAVAILABLE'],
    };
    const client = new MicroserviceClient(makeClientOptions({ retryPolicy }));
    expect((client as any).options.retryPolicy).toEqual(retryPolicy);
  });

  it('should start with empty transports', () => {
    const client = new MicroserviceClient(makeClientOptions());
    expect(client.getTransport('any')).toBeUndefined();
  });
});

describe('MicroserviceClient transport registration', () => {
  let client: MicroserviceClient;

  beforeEach(() => {
    client = new MicroserviceClient(makeClientOptions());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register an RPC transport', () => {
    const transport = makeRpcTransport('rpc');
    client.registerTransport(transport);
    expect(client.getTransport('rpc')).toBe(transport);
  });

  it('should register a messaging transport', () => {
    const transport = makeMessagingTransport('kafka');
    client.registerTransport(transport);
    expect(client.getTransport('kafka')).toBe(transport);
  });

  it('should register multiple transports', () => {
    client.registerTransport(makeRpcTransport('rpc1'));
    client.registerTransport(makeRpcTransport('rpc2'));
    client.registerTransport(makeMessagingTransport('kafka'));
    expect(client.getTransport('rpc1')).toBeDefined();
    expect(client.getTransport('rpc2')).toBeDefined();
    expect(client.getTransport('kafka')).toBeDefined();
  });

  it('should unregister a transport', () => {
    const transport = makeRpcTransport('rpc');
    client.registerTransport(transport);
    expect(client.unregisterTransport('rpc')).toBe(true);
    expect(client.getTransport('rpc')).toBeUndefined();
  });

  it('should return false when unregistering unknown transport', () => {
    expect(client.unregisterTransport('unknown')).toBe(false);
  });

  it('should prefer first RPC transport for calls', () => {
    const rpc1 = makeRpcTransport('rpc1');
    const rpc2 = makeRpcTransport('rpc2');
    client.registerTransport(rpc1);
    client.registerTransport(rpc2);
    // getRpcTransport returns the first one with requestResponse capability
    expect((client as any).getRpcTransport()).toBe(rpc1);
  });

  it('should prefer first messaging transport for publish/subscribe', () => {
    const msg1 = makeMessagingTransport('kafka1');
    const msg2 = makeMessagingTransport('kafka2');
    client.registerTransport(msg1);
    client.registerTransport(msg2);
    expect((client as any).getMessagingTransport()).toBe(msg1);
  });
});

describe('MicroserviceClient call', () => {
  let client: MicroserviceClient;
  let rpcTransport: Transport & RpcClient;

  beforeEach(() => {
    client = new MicroserviceClient(makeClientOptions());
    rpcTransport = makeRpcTransport('rpc');
    client.registerTransport(rpcTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject when no RPC transport available', async () => {
    const client = new MicroserviceClient(makeClientOptions());
    await expect(client.call('svc', 'method', { x: 1 })).rejects.toThrow('No RPC transport available');
  });

  it('should delegate call to RPC transport', async () => {
    const result = await client.call('svc', 'create', { data: 'test' });
    expect(rpcTransport.call).toHaveBeenCalledWith('svc', 'create', { data: 'test' });
    expect(result).toEqual({ success: true });
  });

  it('should handle call errors', async () => {
    rpcTransport.call.mockRejectedValueOnce(new Error('RPC failed'));
    await expect(client.call('svc', 'create', { data: 'test' })).rejects.toThrow('RPC failed');
  });

  it('should pass through different input types', async () => {
    await client.call('svc', 'method', 'string-input');
    expect(rpcTransport.call).toHaveBeenCalledWith('svc', 'method', 'string-input');

    await client.call('svc', 'method', 42);
    expect(rpcTransport.call).toHaveBeenCalledWith('svc', 'method', 42);

    await client.call('svc', 'method', null);
    expect(rpcTransport.call).toHaveBeenCalledWith('svc', 'method', null);
  });
});

describe('MicroserviceClient stream', () => {
  let client: MicroserviceClient;
  let rpcTransport: Transport & RpcClient;

  beforeEach(() => {
    client = new MicroserviceClient(makeClientOptions());
    rpcTransport = makeRpcTransport('rpc');
    client.registerTransport(rpcTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject when no RPC transport available', async () => {
    const client = new MicroserviceClient(makeClientOptions());
    expect(() => client.stream('svc', 'method', { x: 1 })).toThrow('No RPC transport available');
  });

  it('should delegate stream to RPC transport', async () => {
    const gen = client.stream('svc', 'create', { data: 'test' });
    const result = await gen.next();
    expect(rpcTransport.stream).toHaveBeenCalledWith('svc', 'create', { data: 'test' });
    expect(result.value).toEqual({ success: true });
  });

  it('should handle stream errors', async () => {
    rpcTransport.stream.mockImplementationOnce(async function* () {
      throw new Error('Stream failed');
    });
    const gen = client.stream('svc', 'create', { data: 'test' });
    await expect(gen.next()).rejects.toThrow('Stream failed');
  });
});

describe('MicroserviceClient publish', () => {
  let client: MicroserviceClient;
  let msgTransport: Transport & MessagePublisher & MessageSubscriber;

  beforeEach(() => {
    client = new MicroserviceClient(makeClientOptions());
    msgTransport = makeMessagingTransport('kafka');
    client.registerTransport(msgTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject when no messaging transport available', async () => {
    const client = new MicroserviceClient(makeClientOptions());
    await expect(client.publish('topic', { data: 'test' })).rejects.toThrow('No messaging transport available');
  });

  it('should delegate publish to messaging transport', async () => {
    await client.publish('topic', { data: 'test' });
    expect(msgTransport.publish).toHaveBeenCalledWith('topic', { data: 'test' }, undefined);
  });

  it('should pass publish options', async () => {
    await client.publish('topic', { data: 'test' }, { key: 'key1', headers: { 'x-custom': 'value' } });
    expect(msgTransport.publish).toHaveBeenCalledWith('topic', { data: 'test' }, { key: 'key1', headers: { 'x-custom': 'value' } });
  });

  it('should handle publish errors', async () => {
    msgTransport.publish.mockRejectedValueOnce(new Error('Publish failed'));
    await expect(client.publish('topic', { data: 'test' })).rejects.toThrow('Publish failed');
  });
});

describe('MicroserviceClient subscribe', () => {
  let client: MicroserviceClient;
  let msgTransport: Transport & MessagePublisher & MessageSubscriber;

  beforeEach(() => {
    client = new MicroserviceClient(makeClientOptions());
    msgTransport = makeMessagingTransport('kafka');
    client.registerTransport(msgTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject when no messaging transport available', async () => {
    const client = new MicroserviceClient(makeClientOptions());
    await expect(client.subscribe('topic', vi.fn())).rejects.toThrow('No messaging transport available');
  });

  it('should delegate subscribe to messaging transport', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await client.subscribe('topic', handler);
    expect(msgTransport.subscribe).toHaveBeenCalledWith('topic', handler, undefined);
  });

  it('should pass subscribe options', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await client.subscribe('topic', handler, { groupId: 'group1', fromBeginning: true });
    expect(msgTransport.subscribe).toHaveBeenCalledWith('topic', handler, { groupId: 'group1', fromBeginning: true });
  });

  it('should handle subscribe errors', async () => {
    msgTransport.subscribe.mockRejectedValueOnce(new Error('Subscribe failed'));
    await expect(client.subscribe('topic', vi.fn())).rejects.toThrow('Subscribe failed');
  });
});

describe('MicroserviceClient unsubscribe', () => {
  let client: MicroserviceClient;
  let msgTransport: Transport & MessagePublisher & MessageSubscriber;

  beforeEach(() => {
    client = new MicroserviceClient(makeClientOptions());
    msgTransport = makeMessagingTransport('kafka');
    client.registerTransport(msgTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject when no messaging transport available', async () => {
    const client = new MicroserviceClient(makeClientOptions());
    await expect(client.unsubscribe('topic')).rejects.toThrow('No messaging transport available');
  });

  it('should delegate unsubscribe to messaging transport', async () => {
    await client.unsubscribe('topic');
    expect(msgTransport.unsubscribe).toHaveBeenCalledWith('topic');
  });

  it('should handle unsubscribe errors', async () => {
    msgTransport.unsubscribe.mockRejectedValueOnce(new Error('Unsubscribe failed'));
    await expect(client.unsubscribe('topic')).rejects.toThrow('Unsubscribe failed');
  });
});

describe('MicroserviceClient with multiple transports', () => {
  let client: MicroserviceClient;
  let rpcTransport: Transport & RpcClient;
  let msgTransport: Transport & MessagePublisher & MessageSubscriber;

  beforeEach(() => {
    client = new MicroserviceClient(makeClientOptions());
    rpcTransport = makeRpcTransport('grpc');
    msgTransport = makeMessagingTransport('kafka');
    client.registerTransport(rpcTransport);
    client.registerTransport(msgTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use RPC transport for calls', async () => {
    await client.call('svc', 'method', { x: 1 });
    expect(rpcTransport.call).toHaveBeenCalled();
    expect(msgTransport.publish).not.toHaveBeenCalled();
  });

  it('should use messaging transport for publish', async () => {
    await client.publish('topic', { x: 1 });
    expect(msgTransport.publish).toHaveBeenCalled();
    expect(rpcTransport.call).not.toHaveBeenCalled();
  });

  it('should use messaging transport for subscribe', async () => {
    await client.subscribe('topic', vi.fn());
    expect(msgTransport.subscribe).toHaveBeenCalled();
  });

  it('should use messaging transport for unsubscribe', async () => {
    await client.unsubscribe('topic');
    expect(msgTransport.unsubscribe).toHaveBeenCalled();
  });
});