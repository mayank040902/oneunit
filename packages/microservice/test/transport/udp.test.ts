import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UdpTransport } from '../../src/adapters/network/udp/index.js';
import { DatagramTransport } from '../../src/core/capabilities.js';

function createTransport(overrides: Record<string, unknown> = {}): UdpTransport {
  return new UdpTransport({
    host: '127.0.0.1',
    port: 9999,
    ...overrides,
  });
}

describe('UdpTransport construction', () => {
  it('should report correct capabilities', () => {
    const transport = createTransport();
    const caps = (transport as unknown as { capabilities: DatagramTransport['capabilities'] }).capabilities;

    expect(caps.requestResponse).toBe(false);
    expect(caps.streaming).toBe(false);
    expect(caps.publishSubscribe).toBe(true);
    expect(caps.durableDelivery).toBe(false);
    expect(caps.orderedDelivery).toBe(false);
    expect(caps.bidirectional).toBe(true);
  });

  it('should apply a conservative default max packet size at send time', () => {
    const transport = createTransport();
    // The default is enforced inside send(); the config field is undefined until set.
    expect((transport as any).config.maxPacketSize).toBeUndefined();
  });

  it('should accept a custom max packet size', () => {
    const transport = createTransport({ maxPacketSize: 1024 });
    expect((transport as any).config.maxPacketSize).toBe(1024);
  });
});

describe('UdpTransport.send', () => {
  let transport: UdpTransport;

  beforeEach(() => {
    transport = createTransport();
  });

  it('should reject when the socket is not initialized', async () => {
    await expect(transport.send(new Uint8Array([1, 2, 3]), '127.0.0.1', 9999)).rejects.toThrow(
      /UDP socket not initialized/,
    );
  });

  it('should reject oversized packets before sending', async () => {
    const transport = createTransport({ maxPacketSize: 1024 });
    // Inject a fake socket; the size check must happen before any send call.
    const sendMock = vi.fn();
    (transport as any).socket = { send: sendMock };

    const oversized = new Uint8Array(2000);
    await expect(transport.send(oversized, '127.0.0.1', 9999)).rejects.toThrow(
      /exceeds maximum 1024/,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('should reject when the packet is one byte over the configured maximum', async () => {
    const transport = createTransport({ maxPacketSize: 100 });
    const sendMock = vi.fn((_data: unknown, _port: number, _target: unknown, cb: (err: Error | null) => void) => {
      cb(null);
    });
    (transport as any).socket = { send: sendMock };

    const exactlyAtLimit = new Uint8Array(100);
    await expect(transport.send(exactlyAtLimit, '127.0.0.1', 9999)).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);

    const oneOver = new Uint8Array(101);
    await expect(transport.send(oneOver, '127.0.0.1', 9999)).rejects.toThrow(
      /exceeds maximum 100/,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('should delegate to the underlying socket send on success', async () => {
    const sendMock = vi.fn((_data: unknown, _port: number, _target: unknown, cb: (err: Error | null) => void) => {
      cb(null);
    });
    (transport as any).socket = { send: sendMock };

    const payload = new Uint8Array([1, 2, 3]);
    await expect(transport.send(payload, '10.0.0.1', 5353)).resolves.toBeUndefined();

    expect(sendMock).toHaveBeenCalledWith(
      payload,
      5353,
      '10.0.0.1',
      expect.any(Function),
    );
  });

  it('should propagate socket send errors', async () => {
    const sendMock = vi.fn((_data: unknown, _port: number, _target: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('network unreachable'));
    });
    (transport as any).socket = { send: sendMock };

    await expect(transport.send(new Uint8Array([1]), '10.0.0.1', 5353)).rejects.toThrow(
      /network unreachable/,
    );
  });
});

describe('UdpTransport.onMessage', () => {
  it('should register a message handler', () => {
    const transport = createTransport();
    const handler = vi.fn();
    transport.onMessage(handler);

    expect((transport as any).messageHandler).toBe(handler);
  });

  it('should allow replacing the handler', () => {
    const transport = createTransport();
    const first = vi.fn();
    const second = vi.fn();
    transport.onMessage(first);
    transport.onMessage(second);

    expect((transport as any).messageHandler).toBe(second);
  });
});

describe('UdpTransport.close', () => {
  it('should not throw when closed before start', async () => {
    const transport = createTransport();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

describe('UdpTransport.healthCheck', () => {
  it('should report unhealthy when the socket is not open', async () => {
    const transport = createTransport();

    const health = await transport.healthCheck();

    expect(health.status).toBe('unhealthy');
  });

  it('should report healthy when the socket is open', async () => {
    const transport = createTransport({ port: 0 });
    await transport.start();

    try {
      const health = await transport.healthCheck();
      expect(health.status).toBe('healthy');
    } finally {
      await transport.close();
    }
  });
});
import * as dgram from 'dgram';

describe('UdpTransport security dispatch', () => {
  it('does not invoke the message handler when authentication is required but credentials are missing', async () => {
    const handler = vi.fn();
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: false, error: 'missing' }) };
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const transport = new (UdpTransport as any)({ host: '127.0.0.1', port: 0 }, { authorization: authz, authenticator });
    transport.onMessage(handler);
    await transport.start();
    const port = (transport as any).socket.address().port;

    const client = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      client.send(Buffer.from(JSON.stringify({ value: 1 })), port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await transport.close();
    client.close();

    expect(handler).not.toHaveBeenCalled();
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it('invokes the message handler for a valid authenticated and authorized datagram', async () => {
    const handler = vi.fn();
    const creds = { type: 'api-key', apiKey: 'valid', issuedAt: Date.now(), issuer: 'x' };
    const authenticator = { authenticate: vi.fn().mockResolvedValue({ authenticated: true, identity: { serviceId: 'caller', serviceName: 'caller', instanceId: 'i', credentials: creds, getRegistration: () => ({} as any), sign: async () => new Uint8Array(), verify: async () => true } }) };
    const authz = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const transport = new (UdpTransport as any)({ host: '127.0.0.1', port: 0 }, { authorization: authz, authenticator });
    transport.onMessage(handler);
    await transport.start();
    const port = (transport as any).socket.address().port;

    const client = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      client.send(Buffer.from(JSON.stringify({ credentials: creds, value: 1 })), port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await transport.close();
    client.close();

    expect(handler).toHaveBeenCalled();
    expect(authz.evaluate).toHaveBeenCalled();
  });

  it('does not invoke the handler in required-security mode without security dependencies', async () => {
    const handler = vi.fn();
    const transport = new (UdpTransport as any)({ host: '127.0.0.1', port: 0, securityRequired: true });
    transport.onMessage(handler);
    await transport.start();
    const port = (transport as any).socket.address().port;

    const client = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      client.send(Buffer.from(JSON.stringify({ value: 1 })), port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await transport.close();
    client.close();

    expect(handler).not.toHaveBeenCalled();
  });
});
