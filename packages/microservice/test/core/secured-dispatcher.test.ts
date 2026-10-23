import { describe, it, expect, vi } from 'vitest';
import { createSecuredDispatcher } from '../../src/core/secured-dispatcher.js';

describe('SecuredDispatcher', () => {
  it('authenticates and authorizes before handler', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const authorization = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: {}, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    const dispatcher = createSecuredDispatcher({
      service: { serviceId: 'svc', serviceName: 'svc', instanceId: 'x', credentials: {} as any, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } as any,
      authorization: authorization as any,
      authenticator: authenticator as any,
    });

    const request = {
      service: 'svc',
      method: 'method',
      transport: 'test',
      credentials: { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' },
      metadata: new Map([['credentials', { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' }]]),
    };
    await expect(dispatcher.dispatch(request as any, handler)).resolves.toBe('ok');
    expect(authenticator.authenticate).toHaveBeenCalled();
    expect(authorization.evaluate).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    const authCall = authorization.evaluate.mock.calls[0][0];
    expect(authCall.caller.serviceId).toBe('caller');
  });

  it('rejects missing credentials', async () => {
    const handler = vi.fn();
    const authorization = { evaluate: vi.fn() };
    const authenticator = { authenticate: vi.fn() };
    const dispatcher = createSecuredDispatcher({
      service: { serviceId: 'svc', serviceName: 'svc', instanceId: 'x', credentials: {} as any, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } as any,
      authorization: authorization as any,
      authenticator: authenticator as any,
    });
    const request = { service: 'svc', method: 'method', transport: 'test', metadata: new Map() };
    await expect(dispatcher.dispatch(request as any, handler)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(handler).not.toHaveBeenCalled();
    expect(authorization.evaluate).not.toHaveBeenCalled();
  });

  it('rejects authorization denial', async () => {
    const handler = vi.fn();
    const authorization = { evaluate: vi.fn().mockResolvedValue({ allowed: false, reason: 'denied' }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: {}, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    const dispatcher = createSecuredDispatcher({
      service: { serviceId: 'svc', serviceName: 'svc', instanceId: 'x', credentials: {}, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } as any,
      authorization: authorization as any,
      authenticator: authenticator as any,
    });
    const creds = { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' };
    const request = { service: 'svc', method: 'method', transport: 'test', credentials: creds, metadata: new Map([['credentials', creds]]) };
    await expect(dispatcher.dispatch(request as any, handler)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed when authorization missing', async () => {
    const handler = vi.fn();
    const dispatcher = createSecuredDispatcher({
      service: { serviceId: 'svc', serviceName: 'svc', instanceId: 'x', credentials: {}, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } as any,
      authenticationEnabled: true,
    });
    const request = { service: 'svc', method: 'method', transport: 'test', metadata: new Map() };
    await expect(dispatcher.dispatch(request as any, handler)).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(handler).not.toHaveBeenCalled();
  });
});
