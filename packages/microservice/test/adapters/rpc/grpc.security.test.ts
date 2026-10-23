import { describe, it, expect, vi } from "vitest";
import { GrpcTransport, GrpcConfig } from '../../../src/adapters/rpc/grpc/index.js';

function makeConfig(overrides: Partial<GrpcConfig> = {}): GrpcConfig {
  return { endpoint: '127.0.0.1:0', protoPath: '/tmp/test.proto', packageName: 'test', ...overrides };
}

describe('GrpcTransport security', () => {
  it('rejects missing credentials before handler', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const transport = new GrpcTransport(makeConfig(), {
      authorization: { evaluate: vi.fn().mockResolvedValue({ allowed: true }) } as any,
      authenticator: { authenticate: vi.fn().mockResolvedValue({ authenticated: false, error: 'Missing credentials' }) } as any,
    });
    transport.registerMethod('svc', 'method', handler);
    const context = { serviceId: 'remote', correlationId: 'corr', headers: {}, metadata: new Map() } as any;
    await expect(transport.handle('svc', 'method', { x: 1 }, context)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects authorization denial before handler', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: false, reason: 'denied' }) };
    const transport = new GrpcTransport(makeConfig(), {
      authorization: authz as any,
    });
    transport.registerMethod('svc', 'method', handler);
    const context = { serviceId: 'remote', correlationId: 'corr', headers: {}, metadata: new Map() } as any;
    await expect(transport.handle('svc', 'method', { x: 1 }, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes handler and propagates principal on success', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' }, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    const transport = new GrpcTransport(makeConfig(), {
      authorization: authz as any,
      authenticator: authenticator as any,
    });
    transport.registerMethod('svc', 'method', handler);
    const creds = { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' };
    const context = { serviceId: 'remote', correlationId: 'corr', headers: {}, metadata: new Map([['credentials', creds]]) } as any;
    await expect(transport.handle('svc', 'method', { x: 1 }, context)).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
    const authCall = authz.evaluate.mock.calls[0][0];
    expect(authCall.caller.serviceId).toBe('caller');
  });
});
