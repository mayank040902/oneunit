# Kafka Messaging

## Overview & Purpose

The **Kafka Plugin** integrates Apache Kafka event streaming into `@oneunit/server` via the optional peer package `@oneunit/kafka`.

Key capabilities:
- **Fastify Decorator**: Exposes `server.kafka` with ergonomic helpers for producing messages (`send()`), subscribing to topics (`subscribe()`), and consuming message streams (`consume()`).
- **Automated Lifecycle & Teardown**: Hooks into Fastify's `onClose` to automatically disconnect producers, consumers, and admin clients without leaking consumer group rebalance states.
- **Integrated Health Checks**: Automatically registers a Kafka producer acquisition probe into `server.healthRegistry`.
- **Consumer Group Subscriptions**: Allows declarative topic subscription and message callback binding directly in bootstrap configuration.

---

## Installation & Import Requirements

```typescript
import {
  kafkaPlugin,
  type KafkaPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { kafkaPlugin } from "@oneunit/server/plugins";
```

Optional peer dependencies:
```bash
npm install @oneunit/kafka kafkajs
```

---

## Configuration Options

When configuring `kafka` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `kafka` | `boolean \| KafkaPluginOptions` | `false` | Disabled by default. Set to `true` or pass configuration object to enable. |
| `brokers` | `string \| string[]` | — | Array of Kafka broker addresses (e.g. `["localhost:9092"]`). Required to enable the client. |
| `clientId` | `string` | — | Unique logical client identifier reported to the Kafka cluster. |
| `autoConnectProducer` | `boolean` | `false` | When true, connects the Kafka producer immediately during server startup. |
| `consumerGroupId` | `string` | — | Consumer group ID for declarative subscriptions. |
| `subscribeTopics` | `string \| string[]` | — | Topics to subscribe to during server startup. |
| `onMessage` | `(payload) => Promise<void>` | — | Callback invoked for each consumed record: `{ topic, partition, key, value }`. |
| `ssl` | `boolean \| object` | — | TLS/SSL configuration for connecting to cloud Kafka brokers (AWS MSK, Confluent). |
| `sasl` | `object` | — | SASL authentication credentials (`plain`, `scram-sha-256`, `scram-sha-512`). |
| `retry` | `object` | — | Retry policy configuration. |
| `codec` | `"json" \| "avro" \| "protobuf"` | `"json"` | Serialization codec for message values. |
| `parseJson` | `boolean` | `true` | When true, automatically parses JSON string values into objects. |
| `fromBeginning` | `boolean` | `false` | Whether to consume topics from the earliest offset when group has no committed offset. |

---

## Usage Examples

### 1. Producing Messages from API Endpoints

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "order-service",
  kafka: {
    clientId: "order-service",
    brokers: ["localhost:9092"],
    autoConnectProducer: true,
  },
  configure: (server) => {
    server.post("/orders", async (request, reply) => {
      const order = request.body;

      // Publish event to Kafka
      await (server as any).kafka.send("order-created", {
        key: order.id,
        value: {
          orderId: order.id,
          totalAmount: order.total,
          timestamp: Date.now(),
        },
      });

      return reply.created({ data: order });
    });
  },
});
```

### 2. Declarative Event Consumer Setup

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "notifications-worker",
  kafka: {
    clientId: "notification-service",
    brokers: ["localhost:9092"],
    consumerGroupId: "notification-dispatchers",
    subscribeTopics: ["order-created", "user-registered"],
    onMessage: async ({ topic, partition, key, value }) => {
      console.log(`Received message on ${topic} [partition ${partition}]:`, value);
      // Process notification...
    },
  },
});
```

---

## Common Use Cases & Best Practices

1. **Idempotent Producers**: Ensure message publishing is resilient to network retries by configuring standard idempotency options on critical billing or inventory events.
2. **Handle Consumer Errors Gracefully**: Inside `onMessage`, wrap external API calls in `try/catch` and route unrecoverable failures to a Dead Letter Queue (DLQ) topic to avoid halting the consumer offset progression.
3. **Graceful Group Rebalances**: Always rely on Fastify's `onClose` hook to call `kafka.disconnect()`, giving Kafka consumer groups time to rebalance gracefully during deployments.

---

## Edge Cases & Limitations

- **Missing Brokers**: If `brokers` is omitted, `@oneunit/server` outputs an info log and skips client creation to avoid startup crashes in local environments without Kafka.
- **Peer Dependency Fallback**: If `@oneunit/kafka` is not installed, `@oneunit/server` logs a warning and proceeds without Kafka integration.

---

## Related Features

- [Health Checks](health-checks.md)
- [Graceful Shutdown](graceful-shutdown.md)
- [Database](database.md)
