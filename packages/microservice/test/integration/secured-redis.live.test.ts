const LIVE = process.env['RUN_LIVE_INTEGRATION'] === '1';
import { describe, it, expect } from 'vitest';
import { createRedisStore } from '../../src/registry/redis/adapter.js';
import { readFileSync } from 'node:fs';

describe.skipIf(!LIVE)('secured redis', () => {
  const ca = readFileSync('/tmp/kilo/integration-certs/ca.crt', 'utf8');
  it('valid', async () => {
    const store = await createRedisStore({ driver:'ioredis', host:'localhost', port:6380, password:'secret-pass', tls: { ca, rejectUnauthorized:true }, keyPrefix:'t:' } as any);
    const id = crypto.randomUUID();
    await store.set('k', { serviceId:id, instanceId:id, serviceName:'s', endpoints:[], status:'healthy', lastHeartbeat:Date.now(), leaseExpiresAt:Date.now()+5000, capabilities:[], metadata:{} });
    expect(await store.get('k')).not.toBeNull();
    await store.close();
  });
  it('invalid creds', async () => {
    await expect(createRedisStore({ driver:'ioredis', host:'localhost', port:6380, password:'wrong', tls: { ca, rejectUnauthorized:true }, keyPrefix:'t:' } as any)).rejects.toThrow();
  });
  it('untrusted ca', async () => {
    await expect(createRedisStore({ driver:'ioredis', host:'localhost', port:6380, password:'secret-pass', tls: { ca:'INVALID', rejectUnauthorized:true }, keyPrefix:'t:' } as any)).rejects.toThrow();
  });
  it('hostname mismatch', async () => {
    await expect(createRedisStore({ driver:'ioredis', host:'localhost', port:6380, password:'secret-pass', tls: { ca, servername:'wronghost.example', rejectUnauthorized:true }, keyPrefix:'t:' } as any)).rejects.toThrow();
  });
});
