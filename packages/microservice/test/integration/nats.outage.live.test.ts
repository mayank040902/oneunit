import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { NatsTransport } from '../../src/adapters/messaging/nats/index.js';
import { NatsAdapterConfig } from '../../src/config/schema.js';
const LIVE = process.env['RUN_LIVE_INTEGRATION'] === '1';
function makeConfig(): NatsAdapterConfig {
  return { enabled: true, servers: ['nats://localhost:4236'], clientName: 'outage', subjects: { prefix: 'msout' }, jetstream: { enabled: false }, auth: {}, tls: false } as NatsAdapterConfig;
}
function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function startServer() {
  const p = spawn('nats-server', ['-p', '4236']);
  return p;
}
describe.skipIf(!LIVE)('NATS outage recovery', () => {
  let srv = startServer();
  beforeAll(async () => { await delay(500); });
  afterAll(() => { try { srv.kill('SIGKILL'); } catch (e) { void e; } });
  it('reconnects after server restart', async () => {
    const t = new NatsTransport(makeConfig());
    await t.start();
    const received: unknown[] = [];
    await t.subscribe('events', async (m) => { received.push(m); });
    await t.publish('events', { n: 1 });
    await delay(300);
    expect(received).toContainEqual({ n: 1 });

    srv.kill('SIGKILL');
    await delay(300);
    try { await t.publish("events", { n: 2 }); } catch (e) { void e; }
    srv = startServer();
    await delay(1500);
    await t.publish('events', { n: 3 });
    await delay(1000);
    expect(received).toContainEqual({ n: 3 });
    await t.close();
  }, 15000);
});
