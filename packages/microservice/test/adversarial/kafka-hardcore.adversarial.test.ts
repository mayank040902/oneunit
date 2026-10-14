import { describe, it, expect } from 'vitest';
import { KafkaTransport } from '../../src/adapters/messaging/kafka/adapter.js';
import { resetKafkaClient } from '../../src/adapters/messaging/kafka/kafka-client.js';

describe('Kafka Transport - Hardcore Adversarial', () => {
  it('should create transport with defaults', () => {
    const t = new KafkaTransport({ brokers: ['localhost:9092'] } as any);
    expect(t.name).toBe('kafka');
    expect(t.capabilities.publishSubscribe).toBe(true);
    expect(t.capabilities.durableDelivery).toBe(true);
  });
  
  it('should handle config without brokers', () => {
    const t = new KafkaTransport({} as any);
    expect(t).toBeDefined();
  });
  
  it('should track resolved driver state', () => {
    const t = new KafkaTransport({ brokers: ['localhost:9092'], driver: 'auto' } as any);
    expect(t.getResolvedDriver()).toBe('kafkajs');
  });
  
  it('should reject publish before start', async () => {
    const t = new KafkaTransport({ brokers: ['localhost:9092'] } as any);
    await expect(t.publish('topic', { data: 'test' })).rejects.toThrow();
  });
  
  it('should reject subscribe before start', async () => {
    const t = new KafkaTransport({ brokers: ['localhost:9092'] } as any);
    await expect(t.subscribe('topic', async () => {})).rejects.toThrow();
  });
  
  it('should handle unsubscribe before start', async () => {
    const t = new KafkaTransport({ brokers: ['localhost:9092'] } as any);
    await expect(t.unsubscribe('topic')).rejects.toThrow();
  });
});
