import { describe, it, expect, vi } from "vitest";
import { ApiKeyAuthenticator } from '../../src/identity/authentication.js';
import { createSecuredDispatcher } from '../../src/core/secured-dispatcher.js';
import { ServiceCredentials } from '../../src/identity/credentials.js';

describe('ApiKeyAuthenticator hardening', () => {
  it('does not store raw keys', async () => {
    const authenticator = new ApiKeyAuthenticator();
    authenticator.addKey('super-secret-key', 'svc', 'Service');

    const internal = authenticator as unknown as { verifiers: Array<{ verifier: Uint8Array }> };
    expect(internal.verifiers).toHaveLength(1);
    const serialized = JSON.stringify(internal.verifiers[0]?.verifier);
    expect(serialized).not.toContain('super-secret-key');
  });

  it('locks out after configured failures', async () => {
    const authenticator = new ApiKeyAuthenticator({ maxFailedAttempts: 2, lockoutDurationMs: 10_000 });
    const creds: ServiceCredentials = { type: 'api-key', apiKey: 'wrong', issuedAt: Date.now() };

    await authenticator.authenticate(creds);
    await authenticator.authenticate(creds);
    const locked = await authenticator.authenticate(creds);

    expect(locked.authenticated).toBe(false);
    expect(locked.error).toBe('Invalid API key');
  });

  it('recovers after expiry', async () => {
    const authenticator = new ApiKeyAuthenticator({ maxFailedAttempts: 1, lockoutDurationMs: 1 });
    await authenticator.authenticate({ type: 'api-key', apiKey: 'wrong', issuedAt: Date.now() });

    // Wait for lockout to expire.
    await new Promise((resolve) => setTimeout(resolve, 5));
    authenticator.addKey('right', 'svc', 'Service');
    const result = await authenticator.authenticate({ type: 'api-key', apiKey: 'right', issuedAt: Date.now() });
    expect(result.authenticated).toBe(true);
  });

  it('uses timingSafeEqual abstraction', () => {
    class SpyAuthenticator extends ApiKeyAuthenticator {
      public called = false;
      protected timingSafeEqual(left: Buffer, right: Buffer): boolean {
        this.called = true;
        return super.timingSafeEqual(left, right);
      }
    }

    const authenticator = new SpyAuthenticator();
    authenticator.addKey('key', 'svc', 'Service');
    authenticator.removeKey('key');
    expect(authenticator.called).toBe(true);
  });
});

describe('ApiKeyAuthenticator dispatcher integration', () => {
  it('blocks protected work after lockout', async () => {
    const authenticator = new ApiKeyAuthenticator({ maxFailedAttempts: 1, lockoutDurationMs: 10_000 });
    const handler = vi.fn().mockResolvedValue('ok');
    const authorization = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };

    const dispatcher = createSecuredDispatcher({
      service: { serviceId: 'svc', serviceName: 'svc', instanceId: 'x', credentials: {} as any, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true },
      authorization: authorization as any,
      authenticator,
    });

    const wrongCreds = { type: 'api-key', apiKey: 'wrong', issuedAt: Date.now() };
    const request = (creds: any) => ({
      service: 'svc',
      method: 'method',
      transport: 'test',
      credentials: creds,
      metadata: new Map([['credentials', creds]]),
    });

    await expect(dispatcher.dispatch(request(wrongCreds) as any, handler)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(dispatcher.dispatch(request(wrongCreds) as any, handler)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(handler).not.toHaveBeenCalled();
    expect(authorization.evaluate).not.toHaveBeenCalled();
  });
});
