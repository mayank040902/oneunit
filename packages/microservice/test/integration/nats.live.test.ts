import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { NatsTransport } from '../../src/adapters/messaging/nats/index.js';
import { NatsAdapterConfig } from '../../src/config/schema.js';
import { readFileSync } from 'node:fs';
const NATS_CA = readFileSync('/tmp/kilo/integration-certs/ca.crt', 'utf8');

const LIVE = process.env['RUN_LIVE_INTEGRATION'] === '1';

function makeConfig(overrides: Partial<NatsAdapterConfig> = {}): NatsAdapterConfig {
  return {
    enabled: true,
    servers: [process.env['NATS_SERVERS'] ?? 'nats://localhost:4222'],
    clientName: 'integration-nats',
    subjects: { prefix: `jsint` },
    jetstream: { enabled: false },
    auth: {},
    tls: false,
    ...overrides,
  } as NatsAdapterConfig;
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

describe.skipIf(!LIVE)('NATS live integration', () => {
  beforeAll(() => {
    try { execSync('nats -s nats://localhost:4224 stream add JSINT --subjects "jsint.>" --storage file --replicas 1 --defaults 2>/dev/null || true', { stdio:'ignore' }); } catch (e) { void e; }
    try { execSync('nats -s nats://localhost:4224 stream info JSINT >/dev/null 2>&1 || nats -s nats://localhost:4224 stream add JSINT --subjects "jsint.>" --storage memory --defaults', { stdio:'ignore' }); } catch (e) { void e; }
  });
  it('publishes and subscribes on Core NATS', async () => {
    const cfg = makeConfig();
    const t = new NatsTransport(cfg);
    await t.start();
    const received: unknown[] = [];
    await t.subscribe('events', async (m) => { received.push(m); });
    await t.publish('events', { id: 42 });
    await delay(300);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ id: 42 });
    await t.close();
  });

  it('rejects invalid credentials when auth is required', async () => {
    const cfg = makeConfig({
      servers: ['nats://localhost:4223'],
      tls: { ca: NATS_CA, rejectUnauthorized: true },
      auth: { user: 'bad', pass: 'creds' },
    } as Partial<NatsAdapterConfig>);
    const t = new NatsTransport(cfg);
    await expect(t.start()).rejects.toThrow();
  });

  it('valid credentials connect to a secured NATS server', async () => {
    const cfg = makeConfig({
      servers: ['nats://localhost:4223'],
      tls: { ca: NATS_CA, rejectUnauthorized: true },
      auth: { user: 'authuser', pass: 'authpass' },
    } as Partial<NatsAdapterConfig>);
    const t = new NatsTransport(cfg);
    await t.start();
    expect(t.isStarted()).toBe(true);
    await t.close();
  });

  it('JetStream durable consumer persists after restart', async () => {
    const cfg = makeConfig({
      servers: ['nats://localhost:4224'],
      jetstream: { enabled: true },
    } as Partial<NatsAdapterConfig>);
    const producer = new NatsTransport(cfg);
    await producer.start();
    await producer.publish('persisted', { n: 7 });
    await producer.close();

    const consumer = new NatsTransport(cfg);
    await consumer.start();
    const received: unknown[] = [];
    await consumer.subscribe('persisted', async (m) => { received.push(m); }, { groupId: `durable-${Date.now()}` });
    await delay(500);
    expect(received).toContainEqual({ n: 7 });
    await consumer.close();
  });
});
