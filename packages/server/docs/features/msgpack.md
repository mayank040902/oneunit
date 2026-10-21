# MessagePack (Msgpack) Serialization

## Overview & Purpose

**MessagePack** is an efficient binary serialization format that lets you exchange data among multiple languages like JSON, but much faster and smaller.

The **MessagePack Plugin** in `@oneunit/server` provides transparent binary content negotiation:
- **Automatic Request Body Parsing**: Registers content-type parsers for `application/msgpack` and `application/x-msgpack`. Inbound binary payloads are decoded into native JavaScript objects before route handlers or validation hooks run.
- **Transparent Response Encoding**: Inspects the client's HTTP `Accept` header. If the client requests `application/msgpack`, the outgoing response object is automatically encoded into binary MessagePack bytes, saving bandwidth and serialization time.
- **Raw Object Preservation**: Captures the raw JavaScript object in `preSerialization` so that the encoder serializes the actual data structure rather than re-encoding serialized JSON strings.
- **Fastify Decorator**: Exposes `server.msgpack` (`encode`, `decode`, `encoder`, `decoder`, `codec`) for manual serialization.
- **Custom Extension Codecs**: Supports custom MessagePack extension codecs for serializing custom JavaScript types (e.g. `Date`, `BigInt`, `RegExp`).

---

## Architecture & How It Works

```
Inbound Request with Content-Type: application/msgpack
  │
  ▼
[Content-Type Parser: application/msgpack]
  │ (Decodes Buffer via MessagePack Decoder)
  │
  ▼
Route Handler executes with request.body as native JS object
  │
  ▼
[preSerialization Hook]
  │ (Preserves raw JS object in RAW_PAYLOAD symbol)
  │
  ▼
[onSend Hook]
  │
  ├─ Does Accept header include application/msgpack?
  │    ├─ YES: Encodes RAW_PAYLOAD via MessagePack Encoder
  │    │       Sets Content-Type: application/msgpack
  │    │       Returns binary Buffer
  │    │
  │    └─ NO:  Returns default JSON text
```

---

## Installation & Import Requirements

```typescript
import {
  msgpackPlugin,
  type MsgpackPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { msgpackPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @msgpack/msgpack
```

---

## Configuration Options

When configuring `msgpack` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enableBuiltin` | `boolean` | `true` | When true, automatically negotiates msgpack response encoding via the `Accept` header. |
| `extensions` | `Array<{ type: number; encode; decode }>` | `[]` | Custom extension codecs registered to the MessagePack ExtensionCodec. |

To disable MessagePack:
```typescript
const app = await createServer({ msgpack: false });
```

---

## Usage Examples

### 1. Transparent Content Negotiation

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  msgpack: true,
  configure: (server) => {
    server.post("/data", async (request, reply) => {
      // If client sent application/msgpack, request.body is already parsed!
      const received = request.body;

      // If client sent Accept: application/msgpack, this object is automatically encoded to binary!
      return reply.ok({ data: { received, timestamp: Date.now() } });
    });
  },
});
```

#### Client Examples:

**Sending & Receiving JSON (Standard HTTP):**
```bash
curl -X POST http://localhost:8080/data \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'
# Responds with application/json
```

**Receiving MessagePack (High-performance Client):**
```bash
curl -X POST http://localhost:8080/data \
  -H "Content-Type: application/json" \
  -H "Accept: application/msgpack" \
  -d '{"name":"Alice"}' \
  --output response.bin
# Responds with binary Content-Type: application/msgpack
```

### 2. Manual Encoding/Decoding with Server Decorator

```typescript
import { createServer } from "@oneunit/server";

const app = await createServer({
  configure: (server) => {
    server.get("/binary-blob", async (request, reply) => {
      const data = { largeArray: new Array(1000).fill("metric") };

      // Manually encode using decorated instance:
      const buffer = (server as any).msgpack.encode(data);

      reply.header("content-type", "application/octet-stream");
      return Buffer.from(buffer);
    });
  },
});
```

### 3. Registering Custom Extension Codecs (e.g. BigInt)

```typescript
import { startServer } from "@oneunit/server";

await startServer({
  msgpack: {
    extensions: [
      {
        type: 0, // Custom extension type ID (0-127)
        encode: (input: unknown) => {
          if (typeof input === "bigint") {
            return Buffer.from(input.toString());
          }
          return null;
        },
        decode: (data: Uint8Array) => {
          return BigInt(Buffer.from(data).toString());
        },
      },
    ],
  },
});
```

---

## Common Use Cases & Best Practices

1. **Microservice-to-Microservice Traffic**: Use MessagePack for inter-service communication to reduce network payload sizes by 30-50% and dramatically lower JSON parsing CPU usage.
2. **Mobile & IoT Clients**: Conserve mobile data bandwidth and battery life on client devices by sending `Accept: application/msgpack`.
3. **Multi-Value `Accept` Headers**: The plugin safely parses joined multi-value accept headers (e.g., `text/html, application/msgpack;q=0.9`).

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@msgpack/msgpack` is not installed, the plugin logs a warning and skips registration; all routes remain functional with standard JSON.
- **Final Payload Buffer**: Fastify requires all non-string response payloads in `onSend` to be Node.js `Buffer` instances; the plugin automatically converts `Uint8Array` to `Buffer.from(...)`.

---

## Related Features

- [Response Management](response-management.md)
- [Compression](compression.md)
- [Bootstrap](bootstrap.md)
