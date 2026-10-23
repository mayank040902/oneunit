import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TcpTransport, TcpConfig } from '../../../../src/adapters/network/tcp/index.js';

function makeConfig(overrides: Partial<TcpConfig> = {}): TcpConfig {
  return {
    host: '127.0.0.1',
    port: 9999,
    maxFrameSize: 1024 * 1024,
    connectionTimeout: 5000,
    idleTimeout: 30000,
    ...overrides,
  };
}

describe('TcpTransport construction', () => {
  it('should report correct capabilities', () => {
    const transport = new TcpTransport(makeConfig());
    expect(transport.name).toBe('tcp');
    expect(transport.capabilities.requestResponse).toBe(true);
    expect(transport.capabilities.streaming).toBe(true);
    expect(transport.capabilities.publishSubscribe).toBe(false);
    expect(transport.capabilities.durableDelivery).toBe(false);
    expect(transport.capabilities.orderedDelivery).toBe(true);
    expect(transport.capabilities.bidirectional).toBe(true);
  });

  it('should not be started initially', () => {
    const transport = new TcpTransport(makeConfig());
    expect(transport.isStarted()).toBe(false);
  });

  it('should reject the start when TLS is enabled without a certificate and key', async () => {
    const transport = new TcpTransport(makeConfig({ tls: true, port: 0 }));

    await expect(transport.start()).rejects.toThrow(/TLS requires cert and key/);
  });
});

describe('TcpTransport start', () => {
  let transport: TcpTransport;

  beforeEach(() => {
    transport = new TcpTransport(makeConfig({ port: 0 }));
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should start server on specified port', async () => {
    await transport.start();
    expect(transport.isStarted()).toBe(true);
  });

  it('should be idempotent on repeated start calls', async () => {
    await transport.start();
    await transport.start();
    expect(transport.isStarted()).toBe(true);
  });
});

describe('TcpTransport close', () => {
  let transport: TcpTransport;

  beforeEach(() => {
    transport = new TcpTransport(makeConfig({ port: 0 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should close without error when not started', async () => {
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('should close server and connections', async () => {
    await transport.start();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
  });

  it('should be idempotent across repeated close calls', async () => {
    await transport.start();
    await transport.close();
    await transport.close();
    expect(transport.isStarted()).toBe(false);
  });
});

describe('TcpTransport healthCheck', () => {
  let transport: TcpTransport;

  beforeEach(() => {
    transport = new TcpTransport(makeConfig());
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should report unhealthy before start', async () => {
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
    expect(health.checkedAt).toBeDefined();
  });

  it('should report healthy after start', async () => {
    await transport.start();
    const health = await transport.healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.details).toBeDefined();
    expect(health.details!.connections).toBeDefined();
  });
});

describe('TcpTransport openStream', () => {
  let transport: TcpTransport;

  beforeEach(() => {
    transport = new TcpTransport(makeConfig());
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should reject when not started', async () => {
    await expect(transport.openStream('127.0.0.1:9999')).rejects.toThrow();
  });

  it('should reject invalid remote address format', async () => {
    await transport.start();
    await expect(transport.openStream('invalid')).rejects.toThrow(/Invalid remote address format/);
  });

  it('should reject invalid port in remote address', async () => {
    await transport.start();
    await expect(transport.openStream('127.0.0.1:abc')).rejects.toThrow(/Invalid remote address format/);
  });
});

describe('TcpTransport framing', () => {
  let transport: TcpTransport;

  beforeEach(() => {
    transport = new TcpTransport(makeConfig({ maxFrameSize: 1024 }));
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should return metrics with initial values', () => {
    const metrics = transport.getMetrics();
    expect(metrics.messagesSent).toBe(0);
    expect(metrics.messagesReceived).toBe(0);
    expect(metrics.bytesSent).toBe(0);
    expect(metrics.bytesReceived).toBe(0);
    expect(metrics.errors).toBe(0);
  });

  it('should expose the message counters through the health details', async () => {
    await transport.start();
    const health = await transport.healthCheck();
    expect(health.details).toBeDefined();
    expect(health.details!.messagesSent).toBeDefined();
    expect(health.details!.messagesReceived).toBeDefined();
    expect(health.details!.bytesSent).toBeDefined();
    expect(health.details!.bytesReceived).toBeDefined();
    expect(health.details!.errors).toBeDefined();
  });
});

describe('TcpTransport connection handling', () => {
  let server: TcpTransport;
  let client: TcpTransport;

  beforeEach(async () => {
    server = new TcpTransport(makeConfig({ port: 0 }));
    client = new TcpTransport(makeConfig({ port: 0 }));
    await server.start();
    await client.start();
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.restoreAllMocks();
  });

  it('should deliver a written frame to the accepting transport', async () => {
    // The bound port is only observable through the underlying server handle;
    // every assertion below uses the public transport API.
    const port = (server as any).server.address().port as number;

    const stream = await client.openStream(`127.0.0.1:${port}`);
    await stream.write(Buffer.from('HELLO'));

    await vi.waitFor(() => {
      expect(server.getMetrics().messagesReceived).toBe(1);
    });
    expect(server.getMetrics().bytesReceived).toBe(9); // 5 payload bytes + 4 byte header
    expect(client.getMetrics().messagesSent).toBe(1);
  });

  it('should count the accepted connection in the health details', async () => {
    const port = (server as any).server.address().port as number;

    await client.openStream(`127.0.0.1:${port}`);

    await vi.waitFor(async () => {
      const health = await server.healthCheck();
      expect(health.details!.connections).toBe(1);
    });
  });
});

describe('TcpTransport TLS configuration', () => {
  it('should accept TLS config with cert and key paths', () => {
    const transport = new TcpTransport(makeConfig({
      tls: true,
      cert: '/tmp/cert.pem',
      key: '/tmp/key.pem',
      ca: '/tmp/ca.pem',
    }));
    expect((transport as any).config.tls).toBe(true);
    expect((transport as any).config.cert).toBe('/tmp/cert.pem');
    expect((transport as any).config.key).toBe('/tmp/key.pem');
    expect((transport as any).config.ca).toBe('/tmp/ca.pem');
  });
});

describe('TcpTransport error handling', () => {
  let transport: TcpTransport;

  beforeEach(() => {
    transport = new TcpTransport(makeConfig({ port: 0 }));
  });

  afterEach(async () => {
    await transport.close();
    vi.restoreAllMocks();
  });

  it('should handle server errors gracefully', async () => {
    await transport.start();
    const server = (transport as any).server;
    const errorHandler = server.listeners('error')[0];
    expect(errorHandler).toBeDefined();
    
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorHandler(new Error('Test server error'));
    consoleSpy.mockRestore();
    
    const metrics = transport.getMetrics();
    expect(metrics.errors).toBe(1);
  });
});