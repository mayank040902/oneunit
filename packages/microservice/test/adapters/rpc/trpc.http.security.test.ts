import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { TrpcTransport } from '../../../src/adapters/rpc/trpc/index.js';
import { initTRPC } from '@trpc/server';

describe('TrpcTransport HTTP security', () => {
  const port = 39123;
  let transport: TrpcTransport;
  const handler = vi.fn().mockResolvedValue('ok');

  beforeAll(async () => {
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: {}, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    const t = initTRPC.create();
    const router = t.router({ protectedProc: t.procedure.query(() => handler()) });
    transport = new TrpcTransport({ endpoint: `127.0.0.1:${port}`, router }, { authorization: authz as any, authenticator: authenticator as any });
    await transport.start();
  });

  afterAll(async () => {
    await transport.close();
  });

  it('rejects missing credentials over HTTP', async () => {
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: false, error: 'missing' }) };
    const t = initTRPC.create();
    const localHandler = vi.fn().mockResolvedValue('ok');
    const router = t.router({ protectedProc: t.procedure.query(() => localHandler()) });
    const localTransport = new TrpcTransport({ endpoint: `127.0.0.1:${port + 1}`, router }, { authorization: authz as any, authenticator: authenticator as any });
    await localTransport.start();
    const res = await fetch(`http://127.0.0.1:${port + 1}/protectedProc`);
    await localTransport.close();
    expect(localHandler).not.toHaveBeenCalled();
    expect(res.status).not.toBe(200);
  });

  it('valid credentials over HTTP reach resolver', async () => {
    const creds = { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' };
    const res = await fetch(`http://127.0.0.1:${port}/protectedProc`, { headers: { credentials: JSON.stringify(creds) } });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
  });
});
