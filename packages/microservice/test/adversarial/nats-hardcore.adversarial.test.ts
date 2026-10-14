import { describe, it, expect } from 'vitest';
import { NatsTransport } from '../../src/adapters/messaging/nats/index.js';

describe('NATS Transport - Hardcore Adversarial', () => {
  it('should create transport with defaults', () => {
    const t = new NatsTransport({ servers: ['nats://localhost:4222'] } as any);
    expect(t.name).toBe('nats');
    expect(t.capabilities.publishSubscribe).toBe(true);
  });
  
  it('should handle jetstream config', () => {
    const t = new NatsTransport({ 
      servers: ['nats://localhost:4222'],
      jetstream: { enabled: true }
    } as any);
    expect(t.capabilities.durableDelivery).toBe(true);
  });
  
  it('should reject publish before start', async () => {
    const t = new NatsTransport({ servers: ['nats://localhost:4222'] } as any);
    await expect(t.publish('topic', { data: 'test' })).rejects.toThrow();
  });
  
  it('should reject subscribe before start', async () => {
    const t = new NatsTransport({ servers: ['nats://localhost:4222'] } as any);
    await expect(t.subscribe('topic', async () => {})).rejects.toThrow();
  });
  
  it('should handle close before start', async () => {
    const t = new NatsTransport({ servers: ['nats://localhost:4222'] } as any);
    await expect(t.close()).resolves.not.toThrow();
  });
  
  it('should return health status', async () => {
    const t = new NatsTransport({ servers: ['nats://localhost:4222'] } as any);
    const health = await t.healthCheck();
    expect(health.status).toBeDefined();
  });
});
