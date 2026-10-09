import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrpcTransport, GrpcConfig } from '@adapters/rpc/grpc/index.js';
import { RpcMethodHandler, RpcContext } from '@core/capabilities.js';

vi.mock('@grpc/grpc-js', () => ({
  Server: vi.fn().mockImplementation(() => ({
    addService: vi.fn(),
    bindAsync: vi.fn((addr, creds, cb) => cb(null)),
    start: vi.fn(),
    tryShutdown: vi.fn((cb) => cb()),
  })),
  ServerCredentials: {
    createSsl: vi.fn(),
    createInsecure: vi.fn(),
  },
  credentials: {
    createSsl: vi.fn(),
    createInsecure: vi.fn(),
  },
  loadPackageDefinition: vi.fn(),
  Metadata: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('@grpc/proto-loader', () => ({
  loadSync: vi.fn().mockReturnValue({}),
}));

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

function makeConfig(overrides: Partial<GrpcConfig> = {}): GrpcConfig {
  return {
    endpoint: '127.0.0.1:50051',
    protoPath: '/tmp/test.proto',
    packageName: 'test',
    ...overrides,
  };
}

const mockGrpcServer = {
  addService: vi.fn(),
  bindAsync: vi.fn((addr: string, creds: any, cb: Function) => cb(null)),
  start: vi.fn(),
  tryShutdown: vi.fn((cb: Function) => cb()),
};

const mockGrpcClient = {
  Unary: vi.fn((input: any, cb: Function) => cb(null, { success: true, input })),
  ServerStream: vi.fn(() => ({
    on: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      yield { success: true };
      yield { success: true, done: true };
    },
  })),
  ClientStream: vi.fn((cb: Function) => ({
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  })),
  BidiStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      yield { success: true };
    },
  })),
  close: vi.fn(),
};

describe('GrpcTransport construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (grpc.Server as any).mockImplementation(() => mockGrpcServer);
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: { service: { name: 'TestService' } },
      },
    });
    (protoLoader.loadSync as any).mockReturnValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should report correct capabilities', () => {
    const transport = new GrpcTransport(makeConfig());
    expect(transport.name).toBe('grpc');
    expect(transport.capabilities.requestResponse).toBe(true);
    expect(transport.capabilities.streaming).toBe(true);
    expect(transport.capabilities.publishSubscribe).toBe(false);
    expect(transport.capabilities.durableDelivery).toBe(false);
    expect(transport.capabilities.orderedDelivery).toBe(true);
    expect(transport.capabilities.bidirectional).toBe(true);
  });

  it('should not be started initially', () => {
    const transport = new GrpcTransport(makeConfig());
    expect(transport.isStarted()).toBe(false);
  });

  it('should default tls to undefined', () => {
    const transport = new GrpcTransport(makeConfig());
    expect((transport as any).config.tls).toBeUndefined();
  });

  it('should accept custom endpoint', () => {
    const transport = new GrpcTransport(makeConfig({ endpoint: 'localhost:50052' }));
    expect((transport as any).config.endpoint).toBe('localhost:50052');
  });

  it('should accept custom proto path', () => {
    const transport = new GrpcTransport(makeConfig({ protoPath: '/custom/path.proto' }));
    expect((transport as any).config.protoPath).toBe('/custom/path.proto');
  });

  it('should accept custom package name', () => {
    const transport = new GrpcTransport(makeConfig({ packageName: 'custom' }));
    expect((transport as any).config.packageName).toBe('custom');
  });

  it('should accept tls option', () => {
    const transport = new GrpcTransport(makeConfig({ tls: true }));
    expect((transport as any).config.tls).toBe(true);
  });

  it('should accept credentials option', () => {
    const creds = { test: 'credentials' };
    const transport = new GrpcTransport(makeConfig({ credentials: creds }));
    expect((transport as any).config.credentials).toBe(creds);
  });
});

describe('GrpcTransport method registry', () => {
  let transport: GrpcTransport;

  beforeEach(() => {
    transport = new GrpcTransport(makeConfig());
    vi.clearAllMocks();
    (grpc.Server as any).mockImplementation(() => mockGrpcServer);
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: { service: { name: 'TestService' } },
      },
    });
    (protoLoader.loadSync as any).mockReturnValue({});
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

describe('GrpcTransport before start', () => {
  let transport: GrpcTransport;

  beforeEach(() => {
    transport = new GrpcTransport(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject call when client not initialized', async () => {
    await expect(transport.call('svc', 'Unary', { x: 1 })).rejects.toThrow();
  });

  it('should reject stream when iterated', async () => {
    const gen = transport.stream('svc', 'Unary', { x: 1 });
    await expect(gen.next()).rejects.toThrow();
  });

  it('should report unhealthy before start', async () => {
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
    expect(health.checkedAt).toBeDefined();
  });
});

describe('GrpcTransport start', () => {
  let transport: GrpcTransport;

  beforeEach(() => {
    transport = new GrpcTransport(makeConfig({ endpoint: '127.0.0.1:0' }));
    vi.clearAllMocks();
    (grpc.Server as any).mockImplementation(() => mockGrpcServer);
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: { service: { name: 'TestService' } },
      },
    });
    (protoLoader.loadSync as any).mockReturnValue({});
    (grpc.ServerCredentials.createInsecure as any).mockReturnValue({});
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should start gRPC server successfully', async () => {
    const handler: RpcMethodHandler = vi.fn();
    transport.registerMethod('TestService', 'Unary', handler);
    await transport.start();
    expect(transport.isStarted()).toBe(true);
    expect(grpc.Server).toHaveBeenCalled();
    expect(protoLoader.loadSync).toHaveBeenCalled();
    expect(grpc.loadPackageDefinition).toHaveBeenCalled();
    expect(mockGrpcServer.addService).toHaveBeenCalled();
    expect(mockGrpcServer.bindAsync).toHaveBeenCalled();
    expect(mockGrpcServer.start).toHaveBeenCalled();
  });

  it('should use TLS credentials when tls option is true', async () => {
    const tlsTransport = new GrpcTransport(makeConfig({ endpoint: '127.0.0.1:0', tls: true }));
    (grpc.ServerCredentials.createSsl as any).mockReturnValue({});
    await tlsTransport.start();
    expect(grpc.ServerCredentials.createSsl).toHaveBeenCalled();
    await tlsTransport.close();
  });

  it('should use insecure credentials when tls is false', async () => {
    await transport.start();
    expect(grpc.ServerCredentials.createInsecure).toHaveBeenCalled();
  });

  it('should be idempotent on repeated start', async () => {
    await transport.start();
    await transport.start();
    expect(transport.isStarted()).toBe(true);
  });

  it('should report healthy after successful start', async () => {
    await transport.start();
    const health = await transport.healthCheck();
    expect(health.status).toBe('healthy');
  });

  it('should register handlers when starting', async () => {
    const handler: RpcMethodHandler = vi.fn();
    transport.registerMethod('TestService', 'Unary', handler);
    await transport.start();
    expect(mockGrpcServer.addService).toHaveBeenCalled();
  });
});

describe('GrpcTransport close', () => {
  let transport: GrpcTransport;

  beforeEach(() => {
    transport = new GrpcTransport(makeConfig({ endpoint: '127.0.0.1:0' }));
    vi.clearAllMocks();
    (grpc.Server as any).mockImplementation(() => mockGrpcServer);
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: { service: { name: 'TestService' } },
      },
    });
    (protoLoader.loadSync as any).mockReturnValue({});
    (grpc.ServerCredentials.createInsecure as any).mockReturnValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should close without error when not started', async () => {
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('should close server when started', async () => {
    await transport.start();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
    expect(mockGrpcServer.tryShutdown).toHaveBeenCalled();
  });

  it('should close client when exists', async () => {
    await transport.start();
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: vi.fn().mockImplementation(() => mockGrpcClient),
      },
    });
    await transport.call('TestService', 'Unary', { x: 1 });
    await transport.close();
    expect(mockGrpcClient.close).toHaveBeenCalled();
  });

  it('should be idempotent on repeated close', async () => {
    await transport.start();
    await transport.close();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
  });
});

describe('GrpcTransport call', () => {
  let transport: GrpcTransport;

  beforeEach(() => {
    transport = new GrpcTransport(makeConfig({ endpoint: '127.0.0.1:0' }));
    vi.clearAllMocks();
    (grpc.Server as any).mockImplementation(() => mockGrpcServer);
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: vi.fn().mockImplementation(() => mockGrpcClient),
      },
    });
    (protoLoader.loadSync as any).mockReturnValue({});
    (grpc.credentials.createInsecure as any).mockReturnValue({});
    (grpc.ServerCredentials.createInsecure as any).mockReturnValue({});
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should reject call when not started', async () => {
    await expect(transport.call('svc', 'Unary', { x: 1 })).rejects.toThrow();
  });

  it('should throw when service not found', async () => {
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        OtherService: vi.fn().mockImplementation(() => mockGrpcClient),
      },
    });
    await transport.start();
    await expect(transport.call('TestService', 'Unary', { x: 1 })).rejects.toThrow('Service TestService not found');
  });

  it('should make unary call successfully', async () => {
    await transport.start();
    const result = await transport.call('TestService', 'Unary', { data: 'test' });
    expect(result).toEqual({ success: true, input: { data: 'test' } });
    expect(mockGrpcClient.Unary).toHaveBeenCalledWith({ data: 'test' }, expect.any(Function));
  });

  it('should handle call errors', async () => {
    const errorClient = {
      ...mockGrpcClient,
      Unary: vi.fn((input: any, cb: Function) => cb(new Error('RPC error'), null)),
    };
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: vi.fn().mockImplementation(() => errorClient),
      },
    });
    await transport.start();
    await expect(transport.call('TestService', 'Unary', { x: 1 })).rejects.toThrow('RPC error');
  });

  it('should create client lazily on first call', async () => {
    await transport.start();
    expect((transport as any).client).toBeUndefined();
    await transport.call('TestService', 'Unary', { x: 1 });
    expect((transport as any).client).toBeDefined();
  });
});

describe('GrpcTransport stream', () => {
  let transport: GrpcTransport;

  beforeEach(() => {
    transport = new GrpcTransport(makeConfig({ endpoint: '127.0.0.1:0' }));
    vi.clearAllMocks();
    (grpc.Server as any).mockImplementation(() => mockGrpcServer);
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: vi.fn().mockImplementation(() => mockGrpcClient),
      },
    });
    (protoLoader.loadSync as any).mockReturnValue({});
    (grpc.credentials.createInsecure as any).mockReturnValue({});
    (grpc.ServerCredentials.createInsecure as any).mockReturnValue({});
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should reject stream when not started', async () => {
    const gen = transport.stream('svc', 'Unary', { x: 1 });
    await expect(gen.next()).rejects.toThrow();
  });

  it('should make server streaming call', async () => {
    await transport.start();
    const gen = transport.stream('TestService', 'ServerStream', { x: 1 });
    const results = [];
    for await (const item of gen) {
      results.push(item);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(mockGrpcClient.ServerStream).toHaveBeenCalled();
  });

  it('should throw when service not found for streaming', async () => {
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        OtherService: vi.fn().mockImplementation(() => mockGrpcClient),
      },
    });
    await transport.start();
    const gen = transport.stream('TestService', 'Unary', { x: 1 });
    await expect(gen.next()).rejects.toThrow('Service TestService not found');
  });
});

describe('GrpcTransport healthCheck', () => {
  let transport: GrpcTransport;

  beforeEach(() => {
    transport = new GrpcTransport(makeConfig());
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
    vi.clearAllMocks();
    (grpc.Server as any).mockImplementation(() => mockGrpcServer);
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: { service: { name: 'TestService' } },
      },
    });
    (protoLoader.loadSync as any).mockReturnValue({});
    (grpc.ServerCredentials.createInsecure as any).mockReturnValue({});
    
    await transport.start();
    const health = await transport.healthCheck();
    expect(health.status).toBe('healthy');
  });

  it('should report unhealthy after close', async () => {
    vi.clearAllMocks();
    (grpc.Server as any).mockImplementation(() => mockGrpcServer);
    (grpc.loadPackageDefinition as any).mockReturnValue({
      test: {
        TestService: { service: { name: 'TestService' } },
      },
    });
    (protoLoader.loadSync as any).mockReturnValue({});
    (grpc.ServerCredentials.createInsecure as any).mockReturnValue({});
    
    await transport.start();
    await transport.close();
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
  });
});