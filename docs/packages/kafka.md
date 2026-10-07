# @oneunit/kafka

KafkaJS client for Node.js. The only runtime dependency is `kafkajs`. Logger, config, and codecs are adapters.

Package README: `packages/kafka/README.md`

## Install

```bash
npm install @oneunit/kafka
```

## Quick start

```javascript
import { createKafkaClient } from "@oneunit/kafka";

const client = createKafkaClient({
  brokers: "localhost:9092",
  clientId: "orders-service",
  groupId: "orders-workers",
});

await client.send("orders", { orderId: "abc", status: "created" });

await client.consume("orders", async ({ key, value, topic, partition }) => {
  console.log({ topic, partition, key, value });
});

client.registerShutdown();
```

## Adapters

| Adapter | Default | Inject with |
| :--- | :--- | :--- |
| Logger | `console` | `createLoggerAdapter(pinoLogger)` or `{ logger }` |
| Config | `process.env` | `createConfigAdapter(source)` or `{ config }` |
| Codec | JSON | `createCodecAdapter({ encode, decode })` or `{ codec }` |

TLS and SASL are configured via options or `KAFKA_SSL` / `KAFKA_SASL_*` env vars. See `packages/kafka/.env.example`.
