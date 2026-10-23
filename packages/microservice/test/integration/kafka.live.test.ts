import { describe, it, expect } from 'vitest';
import { KafkaTransport } from '../../src/adapters/messaging/kafka/adapter.js';
import { KafkaAdapterConfig } from '../../src/config/schema.js';

const LIVE = process.env['RUN_LIVE_INTEGRATION'] === '1';

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function makeConfig(overrides: Partial<KafkaAdapterConfig> = {}): KafkaAdapterConfig {
  return {
    enabled: true,
    driver: 'kafkajs',
    brokers: [process.env['KAFKA_BROKERS'] ?? 'localhost:9092'],
    clientId: `integration-${Date.now()}`,
    topics: { prefix: `microint.${Date.now()}` },
    ...overrides,
  } as KafkaAdapterConfig;
}

describe.skipIf(!LIVE)('Kafka live integration', () => {
  it('KafkaJS publishes and consumes a message', async () => {
    const cfg = makeConfig();
    const kafkajs = await import('kafkajs');
    const Kafka = (kafkajs as any).Kafka;
    const adminKafka = new Kafka({ clientId: 'admin', brokers: cfg.brokers });
    const admin = adminKafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: `${cfg.topics.prefix}.events`, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
    await admin.disconnect();

    const t = new KafkaTransport(cfg);
    await t.start();
    const received: unknown[] = [];
    await t.subscribe('events', async (m) => { received.push(m); });
    await t.publish('events', { id: 99 });
    await delay(2000);
    expect(received).toContainEqual({ id: 99 });
    await t.close();
  }, 10000);

  it('KafkaJS healthCheck reports connected', async () => {
    const cfg = makeConfig();
    const t = new KafkaTransport(cfg);
    await t.start();
    const h = await t.healthCheck();
    expect(h.status).toBe('healthy');
    await t.close();
  });

  it('KafkaJS survives repeated start/close cycles', async () => {
    for (let i = 0; i < 2; i++) {
      const cfg = makeConfig();
      const t = new KafkaTransport(cfg);
      await t.start();
      await t.close();
    }
  }, 15000);
});

describe.skipIf(!LIVE)('OneUnit Kafka driver live integration', () => {
  it('publishes and consumes a message', async () => {
    const cfg = makeConfig({ driver: 'oneunit' });
    const kafkajs = await import('kafkajs');
    const Kafka = (kafkajs as any).Kafka;
    const adminKafka = new Kafka({ clientId: 'admin', brokers: cfg.brokers });
    const admin = adminKafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: `${cfg.topics.prefix}.events`, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
    await admin.disconnect();

    const t = new KafkaTransport(cfg);
    await t.start();
    const received: unknown[] = [];
    await t.subscribe('events', async (m) => { received.push(m); });
    await t.publish('events', { id: 7 });
    await new Promise((r) => setTimeout(r, 3000));
    expect(received).toContainEqual({ id: 7 });
    await t.close();
  }, 15000);
});
