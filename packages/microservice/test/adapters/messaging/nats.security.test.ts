import { describe, it, expect, vi } from 'vitest';
import { NatsTransport } from '../../../src/adapters/messaging/nats/index.js';

function makeConfig(overrides: any = {}): any {
  return {
    enabled: true,
    servers: ['nats://localhost:4222'],
    clientName: 'test-client',
    subjects: { prefix: 'oneunit' },
    jetstream: { enabled: false },
    auth: {},
    tls: false,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function makeMessage(obj: any, creds?: any) {
  const headers = creds ? { credentials: typeof creds === 'string' ? creds : JSON.stringify(creds) } : undefined;
  return {
    data: new TextEncoder().encode(JSON.stringify(obj)),
    subject: `oneunit.topic`,
    headers,
    ack: vi.fn().mockResolvedValue(undefined),
    nak: vi.fn().mockResolvedValue(undefined),
  };
}

describe('NatsTransport security', () => {
  async function setup(security: any) {
    const cfg = makeConfig({ logger: undefined });
    const transport = new NatsTransport(cfg, security);
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    (transport as any).logger = logger;
    (transport as any).nc = { subscribe: vi.fn(() => subEmpty), publish: vi.fn() };
    (transport as any).started = true;
    // replaced below per call; use holder
    (transport as any)._logger = logger;
    return { transport, logger };
  }

  it('rejects missing credentials before business handler', async () => {
    const security = {
      authorization: { evaluate: vi.fn().mockResolvedValue({ allowed: true }) },
      authenticator: { authenticate: vi.fn().mockResolvedValue({ authenticated: false, error: 'missing' }) },
    };
    const { transport } = await setup(security);
    const logger = (transport as any).logger;
    const messages = [makeMessage({ x: 1 })];
    const sub = makeAsyncSub(messages);
    (transport as any).nc.subscribe = vi.fn(() => sub);
    const bizHandler = vi.fn().mockResolvedValue(undefined);
    await transport.subscribe('topic', bizHandler, {});
    await waitFor(() => (logger.error as any).mock.calls.length > 0 || messages.length === 0, 2000);
    // ensure enough time
    await new Promise((r) => setTimeout(r, 50));
    expect(bizHandler).not.toHaveBeenCalled();
  });

  it('rejects authorization denial before business handler', async () => {
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: false, reason: 'denied' }) };
    const security = { authorization: authz };
    const { transport } = await setup(security);
    const messages = [makeMessage({ x: 1 })];
    const sub = makeAsyncSub(messages);
    (transport as any).nc.subscribe = vi.fn(() => sub);
    const bizHandler = vi.fn().mockResolvedValue(undefined);
    await transport.subscribe('topic', bizHandler, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(bizHandler).not.toHaveBeenCalled();
  });

  it('executes business handler when allowed', async () => {
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' }, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    const security = { authorization: authz, authenticator };
    const { transport } = await setup(security);
    const creds = { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' };
    const messages = [makeMessage({ x: 1 }, creds)];
    const sub = makeAsyncSub(messages);
    (transport as any).nc.subscribe = vi.fn(() => sub);
    const bizHandler = vi.fn().mockResolvedValue(undefined);
    await transport.subscribe('topic', bizHandler, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(bizHandler).toHaveBeenCalledTimes(1);
    expect(authz.evaluate.mock.calls[0][0].caller.serviceId).toBe('caller');
  });
});

function makeAsyncSub(messages: any[]) {
  return {
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: async function* () {
      for (const m of messages) yield m;
    },
  };
}

async function waitFor(cond: () => boolean, timeout: number) {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
