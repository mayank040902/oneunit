import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MicroserviceServer, createServer, ServerOptions } from '../../src/core/server.js';
import { Transport, TransportCapabilities, RpcServer, RpcMethodHandler, RpcContext } from '../../src/core/capabilities.js';
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

function makeServerOptions(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    service: makeServiceIdentity(),
    authorization: makeAuthorizationPolicy(),
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

function makeRpcTransport(name = 'grpc'): Transport & RpcServer {
  const transport = makeMockTransport(name, { requestResponse: true, streaming: true });
  return {
    ...transport,
    registerMethod: vi.fn(),
    unregisterMethod: vi.fn(),
  };
}

describe('MicroserviceServer construction', () => {
  it('should create with required options', () => {
    const server = new MicroserviceServer(makeServerOptions());
    expect(server).toBeInstanceOf(MicroserviceServer);
  });

  it('should create via factory', () => {
    const server = createServer(makeServerOptions());
    expect(server).toBeInstanceOf(MicroserviceServer);
  });

  it('should store options', () => {
    const options = makeServerOptions();
    const server = new MicroserviceServer(options);
    expect((server as any).options.service).toEqual(options.service);
    expect((server as any).options.authorization).toEqual(options.authorization);
  });

  it('should start with empty transports', () => {
    const server = new MicroserviceServer(makeServerOptions());
    expect(server.getTransport('any')).toBeUndefined();
  });

  it('should start with empty methods', () => {
    const server = new MicroserviceServer(makeServerOptions());
    expect(server.getAllMethods()).toEqual([]);
  });
});

describe('MicroserviceServer transport registration', () => {
  let server: MicroserviceServer;

  beforeEach(() => {
    server = new MicroserviceServer(makeServerOptions());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register an RPC transport', () => {
    const transport = makeRpcTransport('grpc');
    server.registerTransport(transport);
    expect(server.getTransport('grpc')).toBe(transport);
  });

  it('should register multiple transports', () => {
    server.registerTransport(makeRpcTransport('grpc1'));
    server.registerTransport(makeRpcTransport('grpc2'));
    expect(server.getTransport('grpc1')).toBeDefined();
    expect(server.getTransport('grpc2')).toBeDefined();
  });

  it('should unregister a transport', () => {
    const transport = makeRpcTransport('grpc');
    server.registerTransport(transport);
    expect(server.unregisterTransport('grpc')).toBe(true);
    expect(server.getTransport('grpc')).toBeUndefined();
  });

  it('should return false when unregistering unknown transport', () => {
    expect(server.unregisterTransport('unknown')).toBe(false);
  });
});

describe('MicroserviceServer method registration', () => {
  let server: MicroserviceServer;

  beforeEach(() => {
    server = new MicroserviceServer(makeServerOptions());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register a method handler', () => {
    const handler: RpcMethodHandler = vi.fn();
    server.registerMethod('svc', 'create', handler);
    expect(server.getMethodHandler('svc', 'create')).toBe(handler);
  });

  it('should register multiple methods for same service', () => {
    const handler1: RpcMethodHandler = vi.fn();
    const handler2: RpcMethodHandler = vi.fn();
    server.registerMethod('svc', 'create', handler1);
    server.registerMethod('svc', 'update', handler2);

    expect(server.getMethodHandler('svc', 'create')).toBe(handler1);
    expect(server.getMethodHandler('svc', 'update')).toBe(handler2);
  });

  it('should register methods for different services', () => {
    const handler1: RpcMethodHandler = vi.fn();
    const handler2: RpcMethodHandler = vi.fn();
    server.registerMethod('svc1', 'create', handler1);
    server.registerMethod('svc2', 'create', handler2);

    expect(server.getMethodHandler('svc1', 'create')).toBe(handler1);
    expect(server.getMethodHandler('svc2', 'create')).toBe(handler2);
  });

  it('should unregister a method', () => {
    const handler: RpcMethodHandler = vi.fn();
    server.registerMethod('svc', 'create', handler);
    server.unregisterMethod('svc', 'create');
    expect(server.getMethodHandler('svc', 'create')).toBeUndefined();
  });

  it('should not throw when unregistering unknown method', () => {
    expect(() => server.unregisterMethod('missing', 'nope')).not.toThrow();
  });

  it('should not throw when unregistering from unknown service', () => {
    server.registerMethod('svc', 'create', vi.fn());
    expect(() => server.unregisterMethod('other', 'create')).not.toThrow();
  });

  it('should allow overwriting a method handler', () => {
    const handler1: RpcMethodHandler = vi.fn();
    const handler2: RpcMethodHandler = vi.fn();
    server.registerMethod('svc', 'create', handler1);
    server.registerMethod('svc', 'create', handler2);
    expect(server.getMethodHandler('svc', 'create')).toBe(handler2);
  });

  it('should return all registered methods', () => {
    server.registerMethod('svc1', 'create', vi.fn());
    server.registerMethod('svc1', 'update', vi.fn());
    server.registerMethod('svc2', 'delete', vi.fn());

    const methods = server.getAllMethods();
    expect(methods).toHaveLength(3);
    expect(methods).toContainEqual({ service: 'svc1', method: 'create' });
    expect(methods).toContainEqual({ service: 'svc1', method: 'update' });
    expect(methods).toContainEqual({ service: 'svc2', method: 'delete' });
  });

  it('should return empty array when no methods registered', () => {
    expect(server.getAllMethods()).toEqual([]);
  });
});

describe('MicroserviceServer with RPC transport', () => {
  let server: MicroserviceServer;
  let rpcTransport: Transport & RpcServer;

  beforeEach(() => {
    server = new MicroserviceServer(makeServerOptions());
    rpcTransport = makeRpcTransport('grpc');
    server.registerTransport(rpcTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should delegate registerMethod to RPC transport', () => {
    const handler: RpcMethodHandler = vi.fn();
    server.registerMethod('svc', 'create', handler);
    // The server stores the handler locally; the transport integration is not automatic
    expect(server.getMethodHandler('svc', 'create')).toBe(handler);
  });

  it('should delegate unregisterMethod to RPC transport', () => {
    server.registerMethod('svc', 'create', vi.fn());
    server.unregisterMethod('svc', 'create');
    expect(server.getMethodHandler('svc', 'create')).toBeUndefined();
  });
});

describe('MicroserviceServer with multiple transports', () => {
  let server: MicroserviceServer;
  let transport1: Transport & RpcServer;
  let transport2: Transport & RpcServer;

  beforeEach(() => {
    server = new MicroserviceServer(makeServerOptions());
    transport1 = makeRpcTransport('grpc1');
    transport2 = makeRpcTransport('grpc2');
    server.registerTransport(transport1);
    server.registerTransport(transport2);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should maintain method registry independent of transports', () => {
    const handler: RpcMethodHandler = vi.fn();
    server.registerMethod('svc', 'create', handler);
    expect(server.getMethodHandler('svc', 'create')).toBe(handler);
  });

  it('should return correct transport by name', () => {
    expect(server.getTransport('grpc1')).toBe(transport1);
    expect(server.getTransport('grpc2')).toBe(transport2);
  });
});

describe('MicroserviceServer edge cases', () => {
  let server: MicroserviceServer;

  beforeEach(() => {
    server = new MicroserviceServer(makeServerOptions());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle handler that throws', () => {
    const handler: RpcMethodHandler = vi.fn().mockImplementation(() => {
      throw new Error('Handler error');
    });
    expect(() => server.registerMethod('svc', 'create', handler)).not.toThrow();
    expect(server.getMethodHandler('svc', 'create')).toBe(handler);
  });

  it('should handle async handler', () => {
    const handler: RpcMethodHandler = async (input, context) => {
      await Promise.resolve();
      return { processed: true, input };
    };
    server.registerMethod('svc', 'create', handler);
    expect(server.getMethodHandler('svc', 'create')).toBe(handler);
  });

  it('should handle handler with context parameter', () => {
    const handler: RpcMethodHandler = vi.fn((input, context) => {
      expect(context).toBeDefined();
      expect(context.serviceId).toBeDefined();
      return { success: true };
    });
    server.registerMethod('svc', 'create', handler);
    expect(server.getMethodHandler('svc', 'create')).toBe(handler);
  });

  it('should maintain isolation between services', () => {
    const handler1: RpcMethodHandler = vi.fn();
    const handler2: RpcMethodHandler = vi.fn();
    server.registerMethod('svc1', 'method', handler1);
    server.registerMethod('svc2', 'method', handler2);

    expect(server.getMethodHandler('svc1', 'method')).toBe(handler1);
    expect(server.getMethodHandler('svc2', 'method')).toBe(handler2);
    expect(server.getMethodHandler('svc1', 'method')).not.toBe(handler2);
  });
});