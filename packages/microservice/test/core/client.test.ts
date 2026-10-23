import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MicroserviceClient, createClient, ClientOptions, RetryPolicy } from '../../src/core/client.js';
import { Transport, TransportCapabilities, RpcClient, MessagePublisher, MessageSubscriber } from '../../src/core/capabilities.js';
import { ServiceIdentity } from '../../src/identity/service-identity.js';
import { AuthorizationPolicy, AllowlistPolicy } from '../../src/identity/authorization.js';
import { createMicroserviceError } from '../../src/core/errors.js';
// Fake timers are enabled per test; restore real timers so a failing test
// cannot leave the remaining tests in fake-timer mode.
afterEach(() => {
  vi.useRealTimers();
});

function makeServiceIdentity(): ServiceIdentity {
  return {
    serviceId: '123e4567-e89b-12d3-a456-426614174000',
    serviceName: 'test-service',
    instanceId: '123e4567-e89b-12d3-a456-426614174001',
    credentials: undefined,
    endpoints: [],
    capabilities: [],
    metadata: {},
  } as ServiceIdentity;
}

function makeAuthorizationPolicy(): AuthorizationPolicy {
  return new AllowlistPolicy(
    [{ serviceId: '123e4567-e89b-12d3-a456-426614174000', allowedOperations: ['*'] }],
    'allow'
  );
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
      idempotent: true,
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
      idempotent: true,
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
      yield Promise.reject(new Error('Stream failed'));
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

describe('MicroserviceClient runtime capability verification', () => {
  it('should reject call when the transport advertises requestResponse but lacks call/stream', async () => {
    const client = new MicroserviceClient(makeClientOptions());
    // A transport that self-reports the capability
    // without implementing the RPC interface.
    const fakeRpc = makeMockTransport('fake-rpc', { requestResponse: true });
    client.registerTransport(fakeRpc);

    await expect(client.call('svc', 'method', { x: 1 })).rejects.toThrow(
      /Transport fake-rpc advertises requestResponse but does not implement RPC call\/stream/,
    );
    expect(() => client.stream('svc', 'method', { x: 1 })).toThrow(
      /does not implement RPC call\/stream/,
    );
  });

  it('should reject publish when the transport advertises publishSubscribe but lacks publish', async () => {
    const client = new MicroserviceClient(makeClientOptions());
    const fakePublisher = makeMockTransport('fake-pub', { publishSubscribe: true });
    client.registerTransport(fakePublisher);

    await expect(client.publish('topic', { x: 1 })).rejects.toThrow(
      /Transport fake-pub advertises publishSubscribe but does not implement publish/,
    );
  });

  it('should reject subscribe when the transport advertises publishSubscribe but lacks subscribe/unsubscribe', async () => {
    const client = new MicroserviceClient(makeClientOptions());
    const publisherOnly: Transport & MessagePublisher = {
      ...makeMockTransport('pub-only', { publishSubscribe: true }),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    client.registerTransport(publisherOnly);

    await expect(client.subscribe('topic', vi.fn())).rejects.toThrow(
      /does not implement subscribe\/unsubscribe/,
    );
    await expect(client.unsubscribe('topic')).rejects.toThrow(
      /does not implement subscribe\/unsubscribe/,
    );
  });
});

describe('RetryPolicy execution', () => {
  function makeRetryingClient(
    call: ReturnType<typeof vi.fn>,
    retryPolicy: RetryPolicy = {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      jitter: false,
      retryableCategories: ['UNAVAILABLE', 'DEADLINE_EXCEEDED'],
      idempotent: true,
    }
  ): MicroserviceClient {
    const client = createClient(makeClientOptions({ retryPolicy }));
    const transport = makeRpcTransport('rpc');
    (transport as any).call = call;
    client.registerTransport(transport);
    return client;
  }

  it('should retry a retryable failure and return the eventual result', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(
        createMicroserviceError('SERVICE_UNAVAILABLE', 'down', 'UNAVAILABLE', true)
      )
      .mockResolvedValueOnce({ success: true });

    const result = await makeRetryingClient(call).call('svc', 'method', { x: 1 });

    expect(result).toEqual({ success: true });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('should give up after maxRetries attempts', async () => {
    const call = vi.fn().mockRejectedValue(
      createMicroserviceError('SERVICE_UNAVAILABLE', 'down', 'UNAVAILABLE', true)
    );

    await expect(
      makeRetryingClient(call).call('svc', 'method', { x: 1 })
    ).rejects.toThrow('down');

    // 1 initial attempt + 3 retries.
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('should fail fast on a non-retryable category', async () => {
    const call = vi.fn().mockRejectedValue(
      createMicroserviceError('INVALID_ARGUMENT', 'bad input', 'VALIDATION', false)
    );

    await expect(
      makeRetryingClient(call).call('svc', 'method', { x: 1 })
    ).rejects.toThrow('bad input');

    expect(call).toHaveBeenCalledTimes(1);
  });

  it('should fail fast on errors outside the normalized error model', async () => {
    const call = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      makeRetryingClient(call).call('svc', 'method', { x: 1 })
    ).rejects.toThrow('boom');

    expect(call).toHaveBeenCalledTimes(1);
  });

  it('should apply exponential backoff capped at maxDelayMs', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(
      createMicroserviceError('SERVICE_UNAVAILABLE', 'down', 'UNAVAILABLE', true)
    );
    const client = makeRetryingClient(call, {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 150,
      jitter: false,
      retryableCategories: ['UNAVAILABLE'],
      idempotent: true,
    });

    const pending = client.call('svc', 'method', { x: 1 });
    // Attach the rejection handler before advancing
    // timers so the eventual failure is not observed
    // as an unhandled rejection.
    const assertion = expect(pending).rejects.toThrow('down');

    // Attempt 1 fails; first backoff is 100ms.
    await vi.advanceTimersByTimeAsync(99);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call).toHaveBeenCalledTimes(2);

    // Attempt 2 fails; second backoff would be 200ms but
    // is capped at maxDelayMs (150ms).
    await vi.advanceTimersByTimeAsync(149);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(call).toHaveBeenCalledTimes(3);

    await assertion;
    vi.useRealTimers();
  });

  it('should not retry publishes: messaging delivery is non-idempotent', async () => {
    const client = createClient(makeClientOptions());
    const transport = makeMockTransport('kafka', { publishSubscribe: true });
    const publish = vi.fn().mockRejectedValue(
      createMicroserviceError('SERVICE_UNAVAILABLE', 'down', 'UNAVAILABLE', true)
    );
    (transport as any).publish = publish;
    client.registerTransport(transport);

    await expect(client.publish('topic', { x: 1 })).rejects.toThrow('down');
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('MicroserviceClient defaultTimeout', () => {
  let client: MicroserviceClient;
  let rpcTransport: Transport & RpcClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new MicroserviceClient(makeClientOptions({ defaultTimeout: 100 }));
    rpcTransport = makeRpcTransport('rpc');
    client.registerTransport(rpcTransport);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should apply defaultTimeout when the call exceeds it', async () => {
    rpcTransport.call.mockImplementation(() => new Promise(() => {}));

    const pending = client.call('svc', 'method', { x: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
      category: 'TIMEOUT',
      retryable: true,
    });
    expect(rpcTransport.call).toHaveBeenCalledTimes(1);
  });

  it('should reject with timeout error when defaultTimeout is set and transport is slow', async () => {
    rpcTransport.call.mockImplementation(
      () => new Promise(resolve => setTimeout(resolve, 500))
    );

    const pending = client.call('svc', 'method', { x: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).rejects.toThrow(/timed out after 100ms/);
  });

  it('should allow per-call timeout to override defaultTimeout', async () => {
    rpcTransport.call.mockImplementation(() => new Promise(() => {}));

    const pending = client.call('svc', 'method', { x: 1 }, { timeout: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('should not time out when the call completes before defaultTimeout', async () => {
    rpcTransport.call.mockResolvedValueOnce({ success: true });

    const result = await client.call('svc', 'method', { x: 1 });
    expect(result).toEqual({ success: true });
    expect(rpcTransport.call).toHaveBeenCalledTimes(1);
  });

  it('should not apply a timeout when defaultTimeout is undefined and no per-call timeout', async () => {
    const clientNoTimeout = new MicroserviceClient(
      makeClientOptions({ defaultTimeout: undefined })
    );
    clientNoTimeout.registerTransport(rpcTransport);

    let resolveCall!: (value: unknown) => void;
    rpcTransport.call.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveCall = resolve;
        })
    );

    const pending = clientNoTimeout.call('svc', 'method', { x: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    resolveCall({ success: true });
    await expect(pending).resolves.toEqual({ success: true });
  });

  it('should combine timeout with retry policy: timeout error is retryable', async () => {
    const clientWithRetry = new MicroserviceClient(
      makeClientOptions({
        defaultTimeout: 50,
        retryPolicy: {
          maxRetries: 1,
          baseDelayMs: 1,
          maxDelayMs: 10,
          jitter: false,
          retryableCategories: ['TIMEOUT'],
          idempotent: true,
        },
      })
    );
    clientWithRetry.registerTransport(rpcTransport);

    let resolveCall!: (value: unknown) => void;
    let callCount = 0;
    rpcTransport.call.mockImplementation(
      () =>
        new Promise(resolve => {
          callCount++;
          resolveCall = resolve;
        })
    );

    const pending = clientWithRetry.call('svc', 'method', { x: 1 });
    await vi.advanceTimersByTimeAsync(50);
    // First attempt times out; retry kicks in after 1ms backoff
    await vi.advanceTimersByTimeAsync(1);
    expect(callCount).toBe(2);
    resolveCall({ success: true });
    await expect(pending).resolves.toEqual({ success: true });
  });

  it('should not apply timeout to publish/subscribe (messaging only)', async () => {
    const msgTransport = makeMessagingTransport('kafka');
    client.registerTransport(msgTransport);
    await expect(
      client.publish('topic', { x: 1 })
    ).resolves.toBeUndefined();
    expect(msgTransport.publish).toHaveBeenCalledTimes(1);
  });

  it('should not retry non-idempotent operations even with retryable category', async () => {
    const call = vi.fn().mockRejectedValue(
      createMicroserviceError('SERVICE_UNAVAILABLE', 'down', 'UNAVAILABLE', true)
    );
    const client = createClient(makeClientOptions({
      retryPolicy: {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
        jitter: false,
        retryableCategories: ['UNAVAILABLE'],
        idempotent: false,
      },
    }));
    const transport = makeRpcTransport('rpc');
    (transport as any).call = call;
    client.registerTransport(transport);

    await expect(client.call('svc', 'method', { x: 1 })).rejects.toThrow('down');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('should not retry errors with retryable:false even if category matches', async () => {
    const call = vi.fn().mockRejectedValue(
      createMicroserviceError('SERVICE_UNAVAILABLE', 'down', 'UNAVAILABLE', false)
    );
    const client = createClient(makeClientOptions({
      retryPolicy: {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
        jitter: false,
        retryableCategories: ['UNAVAILABLE'],
        idempotent: true,
      },
    }));
    const transport = makeRpcTransport('rpc');
    (transport as any).call = call;
    client.registerTransport(transport);

    await expect(client.call('svc', 'method', { x: 1 })).rejects.toThrow('down');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('should enforce deadline across retry attempts', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(
      createMicroserviceError('SERVICE_UNAVAILABLE', 'down', 'UNAVAILABLE', true)
    );
    const client = createClient(makeClientOptions({
      retryPolicy: {
        maxRetries: 10,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitter: false,
        retryableCategories: ['UNAVAILABLE'],
        idempotent: true,
        deadlineMs: 250,
      },
    }));
    const transport = makeRpcTransport('rpc');
    (transport as any).call = call;
    client.registerTransport(transport);

    const pending = client.call('svc', 'method', { x: 1 });
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    vi.useRealTimers();
    // Two attempts fit within the 250ms deadline (t=0 and t=100ms)
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe('MicroserviceClient outbound authorization', () => {
  let client: MicroserviceClient;
  let rpcTransport: Transport & RpcClient;

  const TEST_SERVICE_ID = '123e4567-e89b-12d3-a456-426614174000';

  function makeClientWithPolicy(
    entries: { serviceId: string; allowedOperations: string[] }[],
    defaultPolicy: 'allow' | 'deny' = 'deny'
  ): MicroserviceClient {
    const options = makeClientOptions();
    options.authorization = new AllowlistPolicy(entries, defaultPolicy);
    const c = new MicroserviceClient(options);
    rpcTransport = makeRpcTransport('rpc');
    c.registerTransport(rpcTransport);
    return c;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should deny calls when caller is not in allowlist', async () => {
    client = makeClientWithPolicy([], 'deny');
    rpcTransport.call.mockResolvedValue({ ok: true });

    await expect(client.call('svc', 'method', { x: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      category: 'AUTHORIZATION',
    });
    expect(rpcTransport.call).not.toHaveBeenCalled();
  });

  it('should allow calls when caller and operation are permitted', async () => {
    client = makeClientWithPolicy([
      { serviceId: TEST_SERVICE_ID, allowedOperations: ['svc.method'] },
    ], 'deny');
    rpcTransport.call.mockResolvedValue({ ok: true });

    const result = await client.call('svc', 'method', { x: 1 });
    expect(result).toEqual({ ok: true });
    expect(rpcTransport.call).toHaveBeenCalledTimes(1);
  });

  it('should allow calls when caller uses wildcard operation', async () => {
    client = makeClientWithPolicy([
      { serviceId: TEST_SERVICE_ID, allowedOperations: ['*'] },
    ], 'deny');
    rpcTransport.call.mockResolvedValue({ ok: true });

    const result = await client.call('svc', 'anything', { x: 1 });
    expect(result).toEqual({ ok: true });
    expect(rpcTransport.call).toHaveBeenCalledTimes(1);
  });

  it('should fail fast when authorization policy evaluation fails', async () => {
    const failingPolicy: AuthorizationPolicy = {
      evaluate: async () => {
        throw new Error('policy boom');
      },
    };
    const options = makeClientOptions();
    options.authorization = failingPolicy;
    client = new MicroserviceClient(options);
    rpcTransport = makeRpcTransport('rpc');
    client.registerTransport(rpcTransport);

    await expect(client.call('svc', 'method', { x: 1 })).rejects.toThrow('policy boom');
    expect(rpcTransport.call).not.toHaveBeenCalled();
  });
});