import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseTransport, TransportConfig, TransportHealth } from '../../src/transport/transport.js';

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

