import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BaseTransport,
  TransportConfig,
  Transport,
  TransportCapabilities,
  TransportHealth,
  TransportMetrics,
} from '../../src/transport/transport.js';

describe('BaseTransport', () => {
  let mockTransport: BaseTransport;

  beforeEach(() => {
    const config: TransportConfig = {
      name: 'test-transport',
      capabilities: {
        requestResponse: true,
        streaming: false,
        publishSubscribe: true,
        durableDelivery: false,
        orderedDelivery: true,
        bidirectional: true,
      },
    };

    // Create a concrete implementation for testing
    mockTransport = new (class extends BaseTransport {
      async start(): Promise<void> {
        this.started = true;
      }
      async close(): Promise<void> {
        this.started = false;
      }
      async healthCheck(): Promise<TransportHealth> {
        return {
          status: this.started ? 'healthy' : 'unhealthy',
          checkedAt: Date.now(),
        };
      }
    })(config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create transport with name and capabilities', () => {
    expect(mockTransport.name).toBe('test-transport');
    expect(mockTransport.capabilities.requestResponse).toBe(true);
    expect(mockTransport.capabilities.publishSubscribe).toBe(true);
    expect(mockTransport.capabilities.streaming).toBe(false);
  });

  it('should have started as false initially', () => {
    expect(mockTransport.isStarted()).toBe(false);
  });

  it('should set started to true after start', async () => {
    await mockTransport.start();
    expect(mockTransport.isStarted()).toBe(true);
  });

  it('should set started to false after close', async () => {
    await mockTransport.start();
    await mockTransport.close();
    expect(mockTransport.isStarted()).toBe(false);
  });

  it('should return health status', async () => {
    const health = await mockTransport.healthCheck();
    expect(health).toBeDefined();
    expect(health.status).toBe('unhealthy');
    expect(health.checkedAt).toBeDefined();
  });

  it('should return healthy after start', async () => {
    await mockTransport.start();
    const health = await mockTransport.healthCheck();
    expect(health.status).toBe('healthy');
  });

  it('should allow multiple start calls', async () => {
    await mockTransport.start();
    await mockTransport.start();
    expect(mockTransport.isStarted()).toBe(true);
  });

  it('should allow multiple close calls', async () => {
    await mockTransport.start();
    await mockTransport.close();
    await mockTransport.close();
    expect(mockTransport.isStarted()).toBe(false);
  });
});

describe('TransportCapabilities', () => {
  it('should define correct structure', () => {
    const caps: TransportCapabilities = {
      requestResponse: true,
      streaming: true,
      publishSubscribe: true,
      durableDelivery: true,
      orderedDelivery: true,
      bidirectional: true,
    };

    expect(caps.requestResponse).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.publishSubscribe).toBe(true);
    expect(caps.durableDelivery).toBe(true);
    expect(caps.orderedDelivery).toBe(true);
    expect(caps.bidirectional).toBe(true);
  });

  it('should allow all false capabilities', () => {
    const caps: TransportCapabilities = {
      requestResponse: false,
      streaming: false,
      publishSubscribe: false,
      durableDelivery: false,
      orderedDelivery: false,
      bidirectional: false,
    };

    expect(caps.requestResponse).toBe(false);
  });
});

describe('TransportHealth', () => {
  it('should define correct structure', () => {
    const health: TransportHealth = {
      status: 'healthy',
      checkedAt: Date.now(),
      details: { latency: 100 },
    };

    expect(health.status).toBe('healthy');
    expect(typeof health.checkedAt).toBe('number');
    expect(health.details).toBeDefined();
  });

  it('should support degraded status', () => {
    const health: TransportHealth = {
      status: 'degraded',
      checkedAt: Date.now(),
      details: { reason: 'high latency' },
    };

    expect(health.status).toBe('degraded');
  });

  it('should support unhealthy status', () => {
    const health: TransportHealth = {
      status: 'unhealthy',
      checkedAt: Date.now(),
      details: { error: 'connection refused' },
    };

    expect(health.status).toBe('unhealthy');
  });
});

describe('TransportMetrics', () => {
  it('should define correct structure', () => {
    const metrics: TransportMetrics = {
      messagesSent: 100,
      messagesReceived: 95,
      bytesSent: 102400,
      bytesReceived: 98304,
      errors: 2,
      latencyMs: { min: 1, max: 500, avg: 50, p50: 30, p95: 150, p99: 400 },
    };

    expect(metrics.messagesSent).toBe(100);
    expect(metrics.messagesReceived).toBe(95);
    expect(metrics.bytesSent).toBe(102400);
    expect(metrics.bytesReceived).toBe(98304);
    expect(metrics.errors).toBe(2);
    expect(metrics.latencyMs.avg).toBe(50);
  });
});