import { describe, it, expect, vi } from 'vitest';
import { ConnectTransport, ConnectConfig } from '../../../src/adapters/rpc/connect/index.js';

function cfg(overrides: Partial<ConnectConfig> = {}): ConnectConfig {
  return { endpoint: 'x', transport: {}, services: new Map(), ...overrides };
}

describe('ConnectTransport security', () => {
  it('rejects missing credentials before handler', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const transport = new ConnectTransport(cfg(), {
      authorization: { evaluate: vi.fn().mockResolvedValue({ allowed: true }) } as any,
      authenticator: { authenticate: vi.fn().mockResolvedValue({ authenticated: false, error: 'missing' }) } as any,
    });
    transport.registerMethod('svc', 'method', handler);
    const context = { serviceId: 'remote', correlationId: 'corr', headers: {}, metadata: new Map() } as any;
    await expect(transport.handle('svc', 'method', { x: 1 }, context)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects authorization denial before handler', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: false, reason: 'denied' }) };
    const transport = new ConnectTransport(cfg(), { authorization: authz as any });
    transport.registerMethod('svc', 'method', handler);
    const context = { serviceId: 'remote', correlationId: 'corr', headers: {}, metadata: new Map() } as any;
    await expect(transport.handle('svc', 'method', { x: 1 }, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes handler and propagates principal when allowed', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' }, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    const transport = new ConnectTransport(cfg(), { authorization: authz as any, authenticator: authenticator as any });
    transport.registerMethod('svc', 'method', handler);
    const creds = { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' };
    const context = { serviceId: 'remote', correlationId: 'corr', headers: {}, metadata: new Map([['credentials', creds]]) } as any;
    await expect(transport.handle('svc', 'method', { x: 1 }, context)).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(authz.evaluate.mock.calls[0][0].caller.serviceId).toBe('caller');
  });
});
