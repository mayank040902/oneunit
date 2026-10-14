import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransportManager } from '../../src/transport/manager.js';
import { BaseTransport } from '../../src/transport/transport.js';
import { TransportCapabilities } from '../../src/core/capabilities.js';

class MockTransport extends BaseTransport {
  public shouldFailStart = false;
  public shouldFailClose = false;
  public startedCount = 0;
  public closedCount = 0;
  public messages: any[] = [];
  
  constructor(name: string, caps: Partial<TransportCapabilities> = {}) {
    super({
      name,
      capabilities: {
        requestResponse: true,
        streaming: false,
        publishSubscribe: false,
        durableDelivery: false,
        orderedDelivery: false,
        bidirectional: false,
        ...caps,
      },
    });
  }
  
  async start(): Promise<void> {
    if (this.shouldFailStart) throw new Error('start fail');
    this.started = true;
    this.startedCount++;
  }
  
  async close(): Promise<void> {
    if (this.shouldFailClose) throw new Error('close fail');
    this.started = false;
    this.closedCount++;
  }
  
  async healthCheck() {
    return { status: 'healthy' as const, checkedAt: Date.now() };
  }
}

describe('Transport Manager - Hardcore Adversarial', () => {
  let manager: TransportManager;
  
  beforeEach(() => {
    manager = new TransportManager();
  });
  
  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {}
  });
  
  it('should register and unregister transports', () => {
    const t = new MockTransport('t1');
    manager.register(t);
    expect(manager.get('t1')).toBe(t);
    expect(manager.unregister('t1')).toBe(true);
    expect(manager.get('t1')).toBeUndefined();
    expect(manager.unregister('t1')).toBe(false);
  });
  
  it('should handle duplicate registration', () => {
    const t1 = new MockTransport('t1');
    const t2 = new MockTransport('t1');
    manager.register(t1);
    expect(() => manager.register(t2)).toThrow();
  });
  
  it('should start all transports', async () => {
    manager.register(new MockTransport('t1'));
    manager.register(new MockTransport('t2'));
    await manager.startAll();
  });
  
  it('should aggregate errors on stop', async () => {
    const t1 = new MockTransport('t1');
    t1.shouldFailClose = true;
    manager.register(t1);
    await manager.startAll();
    await expect(manager.stopAll()).rejects.toThrow();
  });
  
  it('should handle concurrent operations', async () => {
    manager.register(new MockTransport('t1'));
    const res = await Promise.allSettled([manager.startAll(), manager.startAll()]);
    expect(res.some(r => r.status === 'fulfilled')).toBe(true);
  });
});
