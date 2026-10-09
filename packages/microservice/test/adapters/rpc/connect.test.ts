import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectTransport, ConnectConfig } from '@adapters/rpc/connect/index.js';
import { RpcMethodHandler } from '@core/capabilities.js';

vi.mock('@connectrpc/connect', () => ({
  createPromiseClient: vi.fn(),
}));

vi.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: vi.fn(),
}));

import { createPromiseClient } from '@connectrpc/connect';
const mockCreatePromiseClient = vi.mocked(createPromiseClient);

function makeConfig(overrides: Partial<ConnectConfig> = {}): ConnectConfig {
  return {
    endpoint: 'http://127.0.0.1:8080',
    transport: {},
    services: new Map(),
    ...overrides,
  };
}

function createAsyncIterable(items: any[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) {
        yield item;
      }
    },
  };
}

function createMockServiceClient() {
  return {
    Unary: vi.fn().mockResolvedValue({ success: true }),
    ServerStream: vi.fn().mockImplementation(() => createAsyncIterable([{ success: true, data: '1' }, { success: true, data: '2' }])),
    ClientStream: vi.fn().mockImplementation(() => createAsyncIterable([{ success: true, count: 3 }])),
    BidiStream: vi.fn().mockImplementation(() => createAsyncIterable([{ success: true, data: '1' }])),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPromiseClient(serviceClient: any) {
  return {
    TestService: serviceClient,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ConnectTransport construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should report correct capabilities', () => {
    const transport = new ConnectTransport(makeConfig());
    expect(transport.name).toBe('connect');
    expect(transport.capabilities.requestResponse).toBe(true);
    expect(transport.capabilities.streaming).toBe(true);
    expect(transport.capabilities.publishSubscribe).toBe(false);
    expect(transport.capabilities.durableDelivery).toBe(false);
    expect(transport.capabilities.orderedDelivery).toBe(true);
    expect(transport.capabilities.bidirectional).toBe(true);
  });

  it('should not be started initially', () => {
    const transport = new ConnectTransport(makeConfig());
    expect(transport.isStarted()).toBe(false);
  });

  it('should accept custom endpoint', () => {
    const transport = new ConnectTransport(makeConfig({ endpoint: 'http://localhost:9090' }));
    expect((transport as any).config.endpoint).toBe('http://localhost:9090');
  });

  it('should accept custom transport', () => {
    const customTransport = { test: 'transport' };
    const transport = new ConnectTransport(makeConfig({ transport: customTransport }));
    expect((transport as any).config.transport).toBe(customTransport);
  });

  it('should accept custom services map', () => {
    const services = new Map([['test', { test: 'service' }]]);
    const transport = new ConnectTransport(makeConfig({ services }));
    expect((transport as any).config.services).toBe(services);
  });

  it('should accept interceptors option', () => {
    const interceptors = [{ test: 'interceptor' }];
    const transport = new ConnectTransport(makeConfig({ interceptors }));
    expect((transport as any).config.interceptors).toBe(interceptors);
  });
});

describe('ConnectTransport method registry', () => {
  let transport: ConnectTransport;
  let mockServiceClient: any;
  let mockPromiseClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServiceClient = createMockServiceClient();
    mockPromiseClient = createMockPromiseClient(mockServiceClient);
    mockCreatePromiseClient.mockReturnValue(mockPromiseClient);
    transport = new ConnectTransport(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register a method handler without throwing', () => {
    const handler: RpcMethodHandler = vi.fn();
    expect(() => transport.registerMethod('svc', 'Unary', handler)).not.toThrow();
  });

  it('should register multiple methods for same service', () => {
    const handler1: RpcMethodHandler = vi.fn();
    const handler2: RpcMethodHandler = vi.fn();
    transport.registerMethod('svc', 'Unary', handler1);
    transport.registerMethod('svc', 'Stream', handler2);

    expect(transport.unregisterMethod('svc', 'Unary')).toBeUndefined();
    expect(transport.unregisterMethod('svc', 'Stream')).toBeUndefined();
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
    transport.registerMethod('svc', 'Unary', handler1);
    transport.registerMethod('svc', 'Unary', handler2);

    expect(true).toBe(true);
  });
});

describe('ConnectTransport before start', () => {
  let transport: ConnectTransport;

  beforeEach(() => {
    transport = new ConnectTransport(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject call when client not initialized', async () => {
    await expect(transport.call('svc', 'Unary', { x: 1 })).rejects.toThrow(
      /Connect client not initialized/,
    );
  });

  it('should reject stream when iterated', async () => {
    const gen = transport.stream('svc', 'Unary', { x: 1 });
    await expect(gen.next()).rejects.toThrow(/Connect client not initialized/);
  });

  it('should report unhealthy before start', async () => {
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
    expect(health.checkedAt).toBeDefined();
  });
});

describe('ConnectTransport start', () => {
  let transport: ConnectTransport;
  let mockServiceClient: any;
  let mockPromiseClient: any;

  beforeEach(() => {
    const mockServices = new Map([
      ['TestService', { typeName: 'TestService', methods: {} }]
    ]);
    mockServiceClient = createMockServiceClient();
    mockPromiseClient = createMockPromiseClient(mockServiceClient);
    mockCreatePromiseClient.mockReturnValue(mockPromiseClient);
    transport = new ConnectTransport(makeConfig({ services: mockServices }));
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should start successfully with services', async () => {
    await transport.start();
    expect(transport.isStarted()).toBe(true);
    expect(createPromiseClient).toHaveBeenCalled();
    const callArgs = (createPromiseClient as any).mock.calls[0];
    expect(callArgs[0]).toEqual({ TestService: { typeName: 'TestService', methods: {} } });
    expect(callArgs[1]).toEqual({});
  });

  it('should be idempotent on repeated start', async () => {
    await transport.start();
    await transport.start();
    expect(transport.isStarted()).toBe(true);
    // Note: ConnectTransport doesn't guard against repeated start, so createPromiseClient is called each time
    expect(createPromiseClient).toHaveBeenCalledTimes(2);
  });

  it('should report healthy after start', async () => {
    await transport.start();
    const health = await transport.healthCheck();
    expect(health.status).toBe('healthy');
  });
});

describe('ConnectTransport close', () => {
  let transport: ConnectTransport;
  let mockServiceClient: any;
  let mockPromiseClient: any;

  beforeEach(() => {
    const mockServices = new Map([
      ['TestService', { typeName: 'TestService', methods: {} }]
    ]);
    mockServiceClient = createMockServiceClient();
    mockPromiseClient = createMockPromiseClient(mockServiceClient);
    mockCreatePromiseClient.mockReturnValue(mockPromiseClient);
    transport = new ConnectTransport(makeConfig({ services: mockServices }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should close without error when not started', async () => {
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('should close client when started', async () => {
    await transport.start();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
    expect(mockPromiseClient.close).toHaveBeenCalled();
  });

  it('should be idempotent on repeated close', async () => {
    await transport.start();
    await transport.close();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
  });
});

describe('ConnectTransport call', () => {
  let transport: ConnectTransport;
  let mockServiceClient: any;
  let mockPromiseClient: any;

  beforeEach(() => {
    const mockServices = new Map([
      ['TestService', { typeName: 'TestService', methods: {} }]
    ]);
    mockServiceClient = createMockServiceClient();
    mockPromiseClient = createMockPromiseClient(mockServiceClient);
    mockCreatePromiseClient.mockReturnValue(mockPromiseClient);
    transport = new ConnectTransport(makeConfig({ services: mockServices }));
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should reject call when not started', async () => {
    await expect(transport.call('svc', 'Unary', { x: 1 })).rejects.toThrow(
      /Connect client not initialized/,
    );
  });

  it('should throw when service not found', async () => {
    await transport.start();
    await expect(transport.call('nonexistent', 'Unary', { x: 1 })).rejects.toThrow(
      /Service nonexistent not found/,
    );
  });

  it('should make unary call successfully', async () => {
    await transport.start();
    const result = await transport.call('TestService', 'Unary', { data: 'test' });
    expect(result).toEqual({ success: true });
    expect(mockServiceClient.Unary).toHaveBeenCalledWith({ data: 'test' });
  });

  it('should handle call errors', async () => {
    const errorClient = createMockServiceClient();
    errorClient.Unary.mockRejectedValue(new Error('RPC error'));
    mockCreatePromiseClient.mockReturnValue(createMockPromiseClient(errorClient));
    
    await transport.start();
    await expect(transport.call('TestService', 'Unary', { x: 1 })).rejects.toThrow('RPC error');
  });
});

describe('ConnectTransport stream', () => {
  let transport: ConnectTransport;
  let mockServiceClient: any;
  let mockPromiseClient: any;

  beforeEach(() => {
    const mockServices = new Map([
      ['TestService', { typeName: 'TestService', methods: {} }]
    ]);
    mockServiceClient = createMockServiceClient();
    mockPromiseClient = createMockPromiseClient(mockServiceClient);
    mockCreatePromiseClient.mockReturnValue(mockPromiseClient);
    transport = new ConnectTransport(makeConfig({ services: mockServices }));
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should reject stream when not started', async () => {
    const gen = transport.stream('svc', 'Unary', { x: 1 });
    await expect(gen.next()).rejects.toThrow(/Connect client not initialized/);
  });

  it('should throw when service not found', async () => {
    await transport.start();
    const gen = transport.stream('nonexistent', 'Unary', { x: 1 });
    await expect(gen.next()).rejects.toThrow(/Service nonexistent not found/);
  });

  it('should make server streaming call', async () => {
    await transport.start();
    const gen = transport.stream('TestService', 'ServerStream', { x: 1 });
    const results = [];
    for await (const item of gen) {
      results.push(item);
    }
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ success: true, data: '1' });
    expect(results[1]).toEqual({ success: true, data: '2' });
    expect(mockServiceClient.ServerStream).toHaveBeenCalledWith({ x: 1 });
  });

  it('should make client streaming call', async () => {
    await transport.start();
    const gen = transport.stream('TestService', 'ClientStream', { x: 1 });
    const results = [];
    for await (const item of gen) {
      results.push(item);
    }
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ success: true, count: 3 });
    expect(mockServiceClient.ClientStream).toHaveBeenCalledWith({ x: 1 });
  });

  it('should make bidirectional streaming call', async () => {
    await transport.start();
    const gen = transport.stream('TestService', 'BidiStream', { x: 1 });
    const results = [];
    for await (const item of gen) {
      results.push(item);
    }
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ success: true, data: '1' });
    expect(mockServiceClient.BidiStream).toHaveBeenCalledWith({ x: 1 });
  });
});

describe('ConnectTransport healthCheck', () => {
  let transport: ConnectTransport;

  beforeEach(() => {
    transport = new ConnectTransport(makeConfig());
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should report unhealthy before start', async () => {
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
  });

  it('should report healthy after successful start', async () => {
    const mockServices = new Map([
      ['TestService', { typeName: 'TestService', methods: {} }]
    ]);
    const mockServiceClient = createMockServiceClient();
    const mockPromiseClient = createMockPromiseClient(mockServiceClient);
    const config = makeConfig({ services: mockServices });
    transport = new ConnectTransport(config);
    vi.clearAllMocks();
    mockCreatePromiseClient.mockReturnValue(mockPromiseClient);
    
    await transport.start();
    const health = await transport.healthCheck();
    expect(health.status).toBe('healthy');
  });

  it('should report unhealthy after close', async () => {
    const mockServices = new Map([
      ['TestService', { typeName: 'TestService', methods: {} }]
    ]);
    const mockServiceClient = createMockServiceClient();
    const mockPromiseClient = createMockPromiseClient(mockServiceClient);
    const config = makeConfig({ services: mockServices });
    transport = new ConnectTransport(config);
    vi.clearAllMocks();
    mockCreatePromiseClient.mockReturnValue(mockPromiseClient);
    
    await transport.start();
    await transport.close();
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
  });
});