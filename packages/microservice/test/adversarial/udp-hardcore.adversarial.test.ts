import { describe, it, expect } from 'vitest';
import { UdpTransport } from '../../src/adapters/network/udp/index.js';

describe('UDP Transport - Hardcore Adversarial', () => {
  it('should create transport with defaults', () => {
    const t = new UdpTransport({ host: '127.0.0.1', port: 0 });
    expect(t.name).toBe('udp');
    expect(t.capabilities.publishSubscribe).toBe(true);
  });
  
  it('should handle start/close cycles', async () => {
    const t = new UdpTransport({ host: '127.0.0.1', port: 0 });
    for (let i = 0; i < 3; i++) {
      await t.start();
      await t.close();
    }
  });
  
  it('should return health status', async () => {
    const t = new UdpTransport({ host: '127.0.0.1', port: 0 });
    await t.start();
    const health = await t.healthCheck();
    expect(health.status).toBeDefined();
    await t.close();
  });
});
