import { describe, it, expect, vi } from 'vitest';
import { KafkaTransport } from '../../../src/adapters/messaging/kafka/adapter.js';

function makeConfig(overrides: any = {}): any {
  return {
    brokers: ['localhost:9092'],
    clientId: 'test',
    topics: { prefix: 'micro' },
    ...overrides,
  };
}

describe('KafkaTransport security', () => {
  async function setup(security: any) {
    const transport = new KafkaTransport(makeConfig(), undefined, security);
    const fakeAdapter: any = {
      name: 'kafka',
      capabilities: transport.capabilities,
      start: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
      publish: vi.fn(),
      subscribe: vi.fn().mockImplementation(async (_topic: any, handler: any, _opts: any) => {
        // keep handler reachable
        (transport as any)._capturedHandler = handler;
      }),
      unsubscribe: vi.fn(),
    };
    (transport as any).driverAdapter = fakeAdapter;
    const bizHandler = vi.fn().mockResolvedValue(undefined);
    await transport.subscribe('topic', bizHandler, { groupId: 'g1' });
    const captured = (transport as any)._capturedHandler as (message: any, context: any) => Promise<void>;
    return { transport, captured, bizHandler };
  }

  it('rejects missing credentials before business handler', async () => {
    const security = {
      authorization: { evaluate: vi.fn().mockResolvedValue({ allowed: true }) },
      authenticator: { authenticate: vi.fn().mockResolvedValue({ authenticated: false, error: 'missing' }) },
    };
    const { captured, bizHandler } = await setup(security);
    const context = { topic: 'micro.topic', headers: {}, correlationId: 'corr' };
    await expect(captured({ x: 1 }, context)).rejects.toBeTruthy();
    expect(bizHandler).not.toHaveBeenCalled();
  });

  it('rejects authorization denial before business handler', async () => {
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: false, reason: 'denied' }) };
    const security = { authorization: authz };
    const { captured, bizHandler } = await setup(security);
    const context = { topic: 'micro.topic', headers: {}, correlationId: 'corr' };
    await expect(captured({ x: 1 }, context)).rejects.toBeTruthy();
    expect(bizHandler).not.toHaveBeenCalled();
  });

  it('executes business handler when allowed', async () => {
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' }, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    const security = { authorization: authz, authenticator };
    const { captured, bizHandler } = await setup(security);
    const creds = { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' };
    const context = { topic: 'micro.topic', headers: { credentials: JSON.stringify(creds) }, correlationId: 'corr' };
    await expect(captured({ x: 1 }, context)).resolves.toBeUndefined();
    expect(bizHandler).toHaveBeenCalledTimes(1);
    expect(authz.evaluate.mock.calls[0][0].caller.serviceId).toBe('caller');
  });
});
