import { describe, it, expect } from 'vitest';
import { BaseTransport } from '../../src/transport/transport.js';
import { TransportCapabilities } from '../../src/core/capabilities.js';

class TestTransport extends BaseTransport {
  public startCalled = false;
  public closeCalled = false;
  
  constructor(name: string, capabilities?: Partial<TransportCapabilities>) {
    super({ name, capabilities: { 
      requestResponse: false, 
      streaming: false, 
      publishSubscribe: false, 
      durableDelivery: false, 
      orderedDelivery: false, 
      bidirectional: false,
      ...capabilities 
    } });
  }
  
  async start(): Promise<void> {
    this.started = true;
    this.startCalled = true;
  }
  
  async close(): Promise<void> {
    this.started = false;
    this.closeCalled = true;
  }
  
  async healthCheck() {
    return { status: 'healthy' as const, checkedAt: Date.now() };
  }
}

describe('Transport - Adversarial Tests', () => {
  it('should track start/close state', async () => {
    const t = new TestTransport('t1');
    expect(t.isStarted()).toBe(false);
    await t.start();
    expect(t.isStarted()).toBe(true);
    await t.close();
    expect(t.isStarted()).toBe(false);
  });

  it('should handle close when not running', async () => {
    const t = new TestTransport('t1');
    await expect(t.close()).resolves.not.toThrow();
  });
});
