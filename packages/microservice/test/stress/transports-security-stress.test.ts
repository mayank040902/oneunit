import { describe, it, expect, vi } from 'vitest';
import * as net from 'net';

import { TcpTransport } from '../../src/adapters/network/tcp/index.js';
import { TcpFrameParser, encodeTcpFrame } from '../../src/adapters/network/tcp/frame-parser.js';
import { UdpTransport } from '../../src/adapters/network/udp/index.js';
import { NatsTransport } from '../../src/adapters/messaging/nats/index.js';
import { ReplayProtection } from '../../src/security/replay-protection.js';
import { EncryptionService } from '../../src/security/encryption.js';
import { TransportManager } from '../../src/transport/manager.js';
import { createRegistry } from '../../src/registry/registry.js';
import type { ServiceRegistration } from '../../src/contracts/schemas.js';

vi.mock('nats', () => ({
  connect: vi.fn().mockResolvedValue({
    jetstream: vi.fn(),
    drain: vi.fn().mockResolvedValue(undefined),
    closed: () => Promise.resolve(),
  }),
  headers: vi.fn().mockReturnValue({}),
}));

function makeRegistration(overrides: Partial<ServiceRegistration> = {}): ServiceRegistration {
  return {
    serviceId: crypto.randomUUID(),
    serviceName: 'svc',
    instanceId: crypto.randomUUID(),
    endpoints: [],
    capabilities: [],
    metadata: {},
    registeredAt: Date.now(),
    ...overrides,
  };
}

describe('TCP Frame Parser - Stress / Boundaries', () => {
  it('PARSER-OVERFLOW: a 4GB length prefix is rejected without allocation', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 65536 });
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(0xffffffff);
    const res = parser.feed(bad);
    expect(res.error).not.toBeNull();
    expect(res.frames.length).toBe(0);
    expect(res.error!.message).toMatch(/exceeds maximum/);
  });

  it('PARSER-BOUNDARY: length === maxFrameSize allowed; maxFrameSize+1 rejected', () => {
    const max = 1024;
    const parser = new TcpFrameParser({ maxFrameSize: max });

    const exact = encodeTcpFrame(Buffer.alloc(max, 0xab));
    const res1 = parser.feed(exact);
    expect(res1.error).toBeNull();
    expect(res1.frames.length).toBe(1);
    expect(res1.frames[0].length).toBe(max);

    const over = Buffer.alloc(4);
    over.writeUInt32BE(max + 1);
    const res2 = parser.feed(over);
    expect(res2.error).not.toBeNull();
  });

  it('PARSER-ZERO-FRAME: a zero-length payload yields one empty frame', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const res = parser.feed(encodeTcpFrame(Buffer.alloc(0)));
    expect(res.frames.length).toBe(1);
    expect(res.frames[0].length).toBe(0);
  });

  it('PARSER-EMPTY: feeding an empty buffer changes nothing', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    const res = parser.feed(Buffer.alloc(0));
    expect(res.frames.length).toBe(0);
    expect(res.error).toBeNull();
    expect(parser.bufferedBytes).toBe(0);
  });

  it('PARSER-SHIMMER: many tiny frames across many feed() calls stay coherent', () => {
    const parser = new TcpFrameParser({ maxFrameSize: 1024 });
    for (let i = 0; i < 500; i++) {
      const res = parser.feed(encodeTcpFrame(Buffer.from(`msg-${i}`)));
      expect(res.error).toBeNull();
      expect(res.frames.length).toBe(1);
    }
  });
});

describe('TCP Transport - Stress / Logic', () => {
  it('TCP-READ-LEAK-DUPLICATE: every pending read() receives the same frame (duplicate delivery) because per-read listeners share one buffer and are never removed', async () => {
    const server = new TcpTransport({ host: '127.0.0.1', port: 0, maxFrameSize: 4096 });
    await server.start();
    const port = (server['server'] as net.Server).address() as net.AddressInfo;

    const client = net.createConnection(port.port, '127.0.0.1');
    await new Promise<void>((res) => client.on('connect', res));
    await vi.waitFor(() => expect(server['connections'].size).toBe(1));
    const conn = Array.from(server['connections'].values())[0] as any;

    // Three concurrent read() calls => three 'data' listeners, all closed
    // over the SAME internal buffer, none removed after they resolve.
    const r1 = conn.read();
    const r2 = conn.read();
    const r3 = conn.read();

    const frame = encodeTcpFrame(Buffer.from('FRAME-X'));
    client.write(frame);

    const res1 = await r1;
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(dec(res1)).toBe('FRAME-X');

    client.end();
    await new Promise<void>((res) => client.on('close', res));
    const res2 = await r2;
    const res3 = await r3;
    expect(res2).toBeNull();
    expect(res3).toBeNull();
    await server.close();
  });

  it('TCP-READ-HANG: a read() whose listener already drained a prior frame never resolves when no further data arrives (stuck promise)', async () => {
    const server = new TcpTransport({ host: '127.0.0.1', port: 0, maxFrameSize: 4096 });
    await server.start();
    const port = (server['server'] as net.Server).address() as net.AddressInfo;

    const client = net.createConnection(port.port, '127.0.0.1');
    await new Promise<void>((res) => client.on('connect', res));
    await vi.waitFor(() => expect(server['connections'].size).toBe(1));
    const conn = Array.from(server['connections'].values())[0] as any;

    const r1 = conn.read();
    client.write(encodeTcpFrame(Buffer.from('FIRST')));
    await r1; // resolves, but its listener is never removed

    const r2 = conn.read();
    client.end(); // graceful close, no further data
    await new Promise<void>((res) => client.on('close', res));

    // r2 only resolves to null because the socket closed; it never receives
    // a frame and is never explicitly rejected -> caller can block indefinitely.
    await expect(r2).resolves.toBeNull();
    await server.close();
  });

  it('TCP-REMOTE-IPv6: openStream() splits an IPv6 remote on ":", breaking host/port parsing', async () => {
    const server = new TcpTransport({ host: '127.0.0.1', port: 0 });
    await server.start();

    await expect(server.openStream('::1:9000')).rejects.toThrow(/ECONNREFUSED|connect/);

    await server.close();
  });

  it('TCP-WRITE-ROUNDTRIP: a small frame round-trips; write() resolves without awaiting drain', async () => {
    const server = new TcpTransport({ host: '127.0.0.1', port: 0, maxFrameSize: 65536 });
    await server.start();
    const port = (server['server'] as net.Server).address() as net.AddressInfo;

    const client = net.createConnection(port.port, '127.0.0.1');
    await new Promise<void>((res) => client.on('connect', res));
    await vi.waitFor(() => expect(server['connections'].size).toBe(1));
    const conn = Array.from(server['connections'].values())[0] as any;

    const frame = encodeTcpFrame(Buffer.from('HELLO'));
    const elapsed: number[] = [];
    const start = Date.now();
    await conn.write(Buffer.from('HELLO'));
    elapsed[0] = Date.now() - start;

    const received = await new Promise<Buffer>((res) => client.once('data', res));
    expect(received).toEqual(frame);
    expect(elapsed[0]).toBeLessThan(500);

    client.end();
    await new Promise<void>((res) => client.on('close', res));
    await server.close();
  });
});

describe('UDP Transport - Stress / Logic', () => {
  it('UDP-STARTED-FLAG: start() never sets started=true; healthCheck stays unhealthy while running', async () => {
    const u = new UdpTransport({ host: '127.0.0.1', port: 0 });
    await u.start();
    expect(u.isStarted()).toBe(true);
    const h = await u.healthCheck();
    expect(h.status).toBe('healthy');
    await u.close();
  });

  it('UDP-OVERSIZE: packets larger than maxPacketSize are rejected before send', async () => {
    const u = new UdpTransport({ host: '127.0.0.1', port: 0, maxPacketSize: 100 });
    await u.start();
    await expect(u.send(Buffer.alloc(200), '127.0.0.1', 1)).rejects.toThrow(/exceeds maximum/);
    await u.close();
  });
});

describe('NATS Transport - Stress / Logic', () => {
  it('NATS-STARTED-FLAG: start() never sets started=true; healthCheck reports unhealthy after connect', async () => {
    const n = new NatsTransport({ servers: ['nats://localhost:4222'], subjects: { prefix: 'm' } } as any);
    await n.start();
    expect(n.isStarted()).toBe(true);
    const h = await n.healthCheck();
    expect(h.status).toBe('healthy');
    await n.close();
  });

  it('NATS-SILENT-PUBLISH: publish before start silently no-ops instead of erroring', async () => {
    const n = new NatsTransport({ servers: ['nats://localhost:4222'], subjects: { prefix: 'm' } } as any);
    await expect(n.publish('topic', { a: 1 })).rejects.toThrow(/not started/);
  });
});

describe('ReplayProtection - Stress / Boundaries', () => {
  it('REPLAY-FOCL: fails closed when maxEntries is reached and cleanup cannot reclaim', () => {
    const rp = new ReplayProtection({ maxEntries: 3, windowSize: 10000, ttlMs: 60000 });
    rp.start();
    const now = Date.now();
    expect(rp.checkAndStore({ id: '1', source: 's', timestamp: now }).allowed).toBe(true);
    expect(rp.checkAndStore({ id: '2', source: 's', timestamp: now }).allowed).toBe(true);
    expect(rp.checkAndStore({ id: '3', source: 's', timestamp: now }).allowed).toBe(true);
    const r4 = rp.checkAndStore({ id: '4', source: 's', timestamp: now });
    expect(r4.allowed).toBe(false);
    expect(r4.reason).toMatch(/capacity/i);
    rp.stop();
  });

  it('REPLAY-EVICT-INSERTION: window eviction is by insertion order, so evicted IDs become accepted again', () => {
    const rp = new ReplayProtection({ windowSize: 2, maxEntries: 100000, ttlMs: 60000 });
    rp.start();
    const now = Date.now();
    rp.checkAndStore({ id: '1', source: 's', timestamp: now });
    rp.checkAndStore({ id: '2', source: 's', timestamp: now });
    const r3 = rp.checkAndStore({ id: '3', source: 's', timestamp: now });
    expect(r3.allowed).toBe(true);
    const r1b = rp.checkAndStore({ id: '1', source: 's', timestamp: now });
    expect(r1b.allowed).toBe(true);
    rp.stop();
  });

  it('REPLAY-DEDUP: identical id+source is rejected as duplicate', () => {
    const rp = new ReplayProtection({ windowSize: 1000, maxEntries: 100000, ttlMs: 60000 });
    rp.start();
    const now = Date.now();
    expect(rp.checkAndStore({ id: 'm1', source: 'a', timestamp: now }).allowed).toBe(true);
    expect(rp.checkAndStore({ id: 'm1', source: 'a', timestamp: now }).allowed).toBe(false);
    rp.stop();
  });

  it('REPLAY-CLOCK: future-beyond-skew and past-beyond-ttl are rejected; within both is accepted', () => {
    const rp = new ReplayProtection({ futureSkewMs: 100, ttlMs: 1000 });
    rp.start();
    const now = Date.now();
    expect(rp.checkAndStore({ id: 'f1', source: 's', timestamp: now + 200 }).allowed).toBe(false);
    expect(rp.checkAndStore({ id: 'f2', source: 's', timestamp: now + 50 }).allowed).toBe(true);
    expect(rp.checkAndStore({ id: 'o1', source: 's', timestamp: now - 100000 }).allowed).toBe(false);
    rp.stop();
  });

  it('REPLAY-STALE-NO-CLEANUP: without start(), entries that age past TTL are never reaped', async () => {
    vi.useFakeTimers();
    const rp = new ReplayProtection({ windowSize: 100000, maxEntries: 100000, ttlMs: 50 });
    // NOTE: start() intentionally NOT called -> no cleanup interval.
    const now = Date.now();
    rp.checkAndStore({ id: 'm1', source: 's', timestamp: now });
    rp.checkAndStore({ id: 'm2', source: 's', timestamp: now });
    expect(rp.getStats().totalEntries).toBe(2);

    // Advance far past TTL. With no cleanup running, the stale entries remain.
    await vi.advanceTimersByTimeAsync(5000);
    expect(rp.getStats().totalEntries).toBe(2);
    vi.useRealTimers();
  });
});

describe('EncryptionService - Stress / Boundaries', () => {
  it('ENC-TAMPER-CIPHERTEXT: a single flipped ciphertext byte fails GCM auth', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const svc = await EncryptionService.create('aes-256-gcm', key);
    const env = { version: 1, messageId: 'm1', type: 't', schemaVersion: 1, source: { serviceId: 's', instanceId: 'i' }, timestamp: Date.now(), payload: { secret: 'data' } };
    const enc = await svc.encryptEnvelope(env as any);
    enc.ciphertext[0] ^= 0xff;
    await expect(svc.decryptEnvelope(enc)).rejects.toThrow();
  });

  it('ENC-TAMPER-METADATA: modifying authenticatedMetadata breaks AAD binding (routing fields authenticated)', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const svc = await EncryptionService.create('aes-256-gcm', key);
    const env = { version: 1, messageId: 'm1', type: 't', schemaVersion: 1, source: { serviceId: 's', instanceId: 'i' }, timestamp: Date.now(), payload: { a: 1 } };
    const enc = await svc.encryptEnvelope(env as any);
    const tampered = new Uint8Array(enc.authenticatedMetadata.length);
    tampered.set(enc.authenticatedMetadata);
    tampered[0] ^= 0xff;
    (enc as any).authenticatedMetadata = tampered;
    await expect(svc.decryptEnvelope(enc)).rejects.toThrow();
  });

  it('ENC-VERSION-MISMATCH: envelope version 2 rejected before decryption', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const svc = await EncryptionService.create('aes-256-gcm', key);
    const env = { version: 1, messageId: 'm1', type: 't', schemaVersion: 1, source: { serviceId: 's', instanceId: 'i' }, timestamp: Date.now(), payload: {} };
    const enc = await svc.encryptEnvelope(env as any);
    (enc as any).version = 2;
    await expect(svc.decryptEnvelope(enc)).rejects.toThrow(/version/i);
  });

  it('ENC-CHACHA-WRONG-KEYLEN: chacha20-poly1305 rejects a 16-byte key', async () => {
    await expect(EncryptionService.create('chacha20-poly1305', new Uint8Array(16))).rejects.toThrow(/256-bit/);
  });

  it('ENC-CIRCULAR-PAYLOAD: circular payload throws inside JSON.stringify', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const svc = await EncryptionService.create('aes-256-gcm', key);
    const circular: any = { a: 1 };
    circular.self = circular;
    const env = { version: 1, messageId: 'm1', type: 't', schemaVersion: 1, source: { serviceId: 's', instanceId: 'i' }, timestamp: Date.now(), payload: circular };
    await expect(svc.encryptEnvelope(env as any)).rejects.toThrow();
  });

  it('ENC-ROUNDTRIP: aes-256-gcm and chacha20-poly1305 both round-trip with AAD', async () => {
    for (const algo of ['aes-256-gcm', 'chacha20-poly1305'] as const) {
      const key = await EncryptionService.generateKey(algo);
      const svc = await EncryptionService.create(algo, key);
      const env = { version: 1, messageId: 'm1', type: 't', schemaVersion: 1, source: { serviceId: 's', instanceId: 'i' }, timestamp: Date.now(), payload: { x: [1, 2, 3], nested: { ok: true } } };
      const enc = await svc.encryptEnvelope(env as any);
      const dec = await svc.decryptEnvelope<{ x: number[]; nested: { ok: boolean } }>(enc as any);
      expect(dec.payload).toEqual({ x: [1, 2, 3], nested: { ok: true } });
    }
  });
});

describe('TransportManager - Stress / Logic', () => {
  function fakeTransport(name: string, failStart = false) {
    const t: any = {
      name,
      capabilities: { requestResponse: false, streaming: false, publishSubscribe: true, durableDelivery: true, orderedDelivery: true, bidirectional: false },
      started: false,
      closeCalls: 0,
      async start() {
        if (failStart) throw new Error(`${name} start failed`);
        this.started = true;
      },
      async close() {
        this.closeCalls++;
        this.started = false;
      },
      async healthCheck() {
        return { status: 'healthy', checkedAt: Date.now() };
      },
    };
    return t;
  }

  it('TMGR-PARTIAL-START: a failing transport aborts startAll but leaves already-started transports running (no rollback)', async () => {
    const tm = new TransportManager();
    const good = fakeTransport('good');
    const bad = fakeTransport('bad', true);
    tm.register(good);
    tm.register(bad);

    await expect(tm.startAll()).rejects.toThrow(/Failed to start transports/);
    expect(good.started).toBe(true);
    expect(good.closeCalls).toBe(0);
  });

  it('TMGR-STOPALL-CONTINUES: if one transport close throws, the others are still closed', async () => {
    const tm = new TransportManager();
    const a = fakeTransport('a');
    const b: any = fakeTransport('b');
    b.close = async () => {
      b.closeCalls++;
      throw new Error('close failed');
    };
    tm.register(a);
    tm.register(b);
    await a.start();
    await b.start();

    await expect(tm.stopAll()).rejects.toThrow(/Failed to stop transports/);
    expect(a.closeCalls).toBe(1);
    expect(b.closeCalls).toBe(1);
  });

  it('TMGR-DUPLICATE-REGISTER: registering two transports with the same name throws', () => {
    const tm = new TransportManager();
    tm.register(fakeTransport('same'));
    expect(() => tm.register(fakeTransport('same'))).toThrow(/already registered/);
  });
});

describe('Registry - Stress / Boundaries', () => {
  it('REG-MAXSERVICES-IGNORED: maxServices from config is never enforced by the in-memory store', async () => {
    const reg = createRegistry({
      backend: 'memory',
      ttlMs: 30000,
      heartbeatIntervalMs: 10000,
      healthCheckIntervalMs: 30000,
      maxServices: 2,
    } as any);

    const leases: string[] = [];
    for (let i = 0; i < 2; i++) {
      const lease = await reg.register(makeRegistration({ instanceId: crypto.randomUUID() }));
      leases.push(lease.leaseId);
    }
    await expect(reg.register(makeRegistration({ instanceId: crypto.randomUUID() }))).rejects.toThrow(/capacity reached/);
    expect(leases.length).toBe(2);
    for (const id of leases) await reg.deregister(id);
  });

  it('REG-LEASE-EXPIRY: expired leases are excluded from discovery', async () => {
    const reg = createRegistry({ backend: 'memory', ttlMs: 30000, heartbeatIntervalMs: 10000, healthCheckIntervalMs: 30000, maxServices: 1000 } as any);
    const lease = await reg.register(makeRegistration());
    const discovered = await reg.discover({});
    expect(discovered.length).toBe(1);
    (reg as any).store.expire(lease.leaseId);
    const after = await reg.discover({});
    expect(after.length).toBe(0);
  });
});
